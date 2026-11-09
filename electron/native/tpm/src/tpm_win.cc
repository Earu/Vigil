#include <windows.h>
#include <bcrypt.h>
#include <ncrypt.h>

#include "tpm_common.h"

namespace vigil_tpm {

namespace {

constexpr DWORD kKeyBits = 2048;
constexpr DWORD kBlockBytes = kKeyBits / 8;
constexpr DWORD kDigestBytes = 32;
constexpr char kSealContext[] = "vigil-pin-seal-v1";

struct Provider {
    NCRYPT_PROV_HANDLE handle = 0;
    ~Provider() {
        if (handle) NCryptFreeObject(handle);
    }
};

// The Platform Crypto Provider refuses NCRYPT_SILENT_FLAG on delete with
// NTE_BAD_FLAGS, which left every key behind. Deleting shows no UI anyway
struct Key {
    NCRYPT_KEY_HANDLE handle = 0;
    ~Key() {
        if (handle) NCryptFreeObject(handle);
    }
    SECURITY_STATUS Delete() {
        if (!handle) return ERROR_SUCCESS;
        SECURITY_STATUS status = NCryptDeleteKey(handle, NCRYPT_SILENT_FLAG);
        if (status == NTE_BAD_FLAGS) status = NCryptDeleteKey(handle, 0);
        if (status == ERROR_SUCCESS) handle = 0;
        return status;
    }
};

std::wstring Wide(const std::string& utf8) {
    if (utf8.empty()) return std::wstring();
    int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
    if (length <= 0) return std::wstring();
    std::wstring wide(static_cast<size_t>(length), L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), static_cast<int>(utf8.size()), &wide[0], length);
    return wide;
}

void ScrubWide(std::wstring& text) {
    if (!text.empty()) SecureZeroMemory(&text[0], text.size() * sizeof(wchar_t));
    text.clear();
}

BCRYPT_OAEP_PADDING_INFO Oaep() {
    return BCRYPT_OAEP_PADDING_INFO{BCRYPT_SHA256_ALGORITHM, nullptr, 0};
}

BCRYPT_PKCS1_PADDING_INFO Pkcs1() {
    return BCRYPT_PKCS1_PADDING_INFO{BCRYPT_SHA256_ALGORITHM};
}

// Encrypting to the key is a public-key operation any process can perform
// without the PIN, so a ciphertext alone proves nothing about who made it.
// The PIN-gated signature over it does: unseal refuses a ciphertext the key
// did not sign, before the PIN is spent on it
SECURITY_STATUS Digest(const uint8_t* ciphertext, std::vector<uint8_t>& digest) {
    std::vector<uint8_t> message(kSealContext, kSealContext + sizeof(kSealContext));
    message.insert(message.end(), ciphertext, ciphertext + kBlockBytes);
    digest.assign(kDigestBytes, 0);
    NTSTATUS status = BCryptHash(BCRYPT_SHA256_ALG_HANDLE, nullptr, 0, message.data(), static_cast<ULONG>(message.size()),
                                 digest.data(), kDigestBytes);
    return BCRYPT_SUCCESS(status) ? ERROR_SUCCESS : NTE_FAIL;
}

uint32_t Code(SECURITY_STATUS status) {
    return static_cast<uint32_t>(status);
}

SECURITY_STATUS OpenProvider(Provider& provider) {
    return NCryptOpenStorageProvider(&provider.handle, MS_PLATFORM_CRYPTO_PROVIDER, 0);
}

SECURITY_STATUS SetPin(NCRYPT_KEY_HANDLE key, const std::string& pin) {
    std::wstring wide = Wide(pin);
    if (wide.empty()) return NTE_INVALID_PARAMETER;
    SECURITY_STATUS status = NCryptSetProperty(
        key, NCRYPT_PIN_PROPERTY, reinterpret_cast<PBYTE>(&wide[0]),
        static_cast<DWORD>((wide.size() + 1) * sizeof(wchar_t)), 0);
    ScrubWide(wide);
    return status;
}

SECURITY_STATUS OpenKey(Provider& provider, Key& key, const std::wstring& name) {
    SECURITY_STATUS status = OpenProvider(provider);
    if (status != ERROR_SUCCESS) return status;
    return NCryptOpenKey(provider.handle, &key.handle, name.c_str(), 0, NCRYPT_SILENT_FLAG);
}

}  // namespace

Outcome Seal(const Request& request) {
    std::wstring name = Wide(request.name);
    if (name.empty() || !IsSecret(request.input)) return Outcome{kBadInput, {}};

    Provider provider;
    SECURITY_STATUS status = OpenProvider(provider);
    if (status != ERROR_SUCCESS) return Outcome{Code(status), {}};

    Key key;
    status = NCryptCreatePersistedKey(provider.handle, &key.handle, BCRYPT_RSA_ALGORITHM, name.c_str(), 0, NCRYPT_OVERWRITE_KEY_FLAG);
    if (status != ERROR_SUCCESS) return Outcome{Code(status), {}};

    DWORD length = kKeyBits;
    DWORD usage = NCRYPT_ALLOW_DECRYPT_FLAG | NCRYPT_ALLOW_SIGNING_FLAG;
    status = NCryptSetProperty(key.handle, NCRYPT_LENGTH_PROPERTY, reinterpret_cast<PBYTE>(&length), sizeof(length), 0);
    if (status == ERROR_SUCCESS) {
        status = NCryptSetProperty(key.handle, NCRYPT_KEY_USAGE_PROPERTY, reinterpret_cast<PBYTE>(&usage), sizeof(usage), 0);
    }
    if (status == ERROR_SUCCESS) status = SetPin(key.handle, request.pin);
    if (status == ERROR_SUCCESS) status = NCryptFinalizeKey(key.handle, NCRYPT_SILENT_FLAG);
    if (status != ERROR_SUCCESS) {
        key.Delete();
        return Outcome{Code(status), {}};
    }

    PBYTE input = const_cast<PBYTE>(request.input.data());
    DWORD inputSize = static_cast<DWORD>(request.input.size());
    BCRYPT_OAEP_PADDING_INFO padding = Oaep();
    DWORD size = 0;
    status = NCryptEncrypt(key.handle, input, inputSize, &padding, nullptr, 0, &size, NCRYPT_PAD_OAEP_FLAG);
    std::vector<uint8_t> sealed(size);
    if (status == ERROR_SUCCESS) {
        status = NCryptEncrypt(key.handle, input, inputSize, &padding, sealed.data(), size, &size, NCRYPT_PAD_OAEP_FLAG);
    }
    if (status == ERROR_SUCCESS && size != kBlockBytes) status = NTE_BAD_LEN;

    std::vector<uint8_t> digest;
    if (status == ERROR_SUCCESS) status = Digest(sealed.data(), digest);
    if (status == ERROR_SUCCESS) status = SetPin(key.handle, request.pin);
    BCRYPT_PKCS1_PADDING_INFO pkcs1 = Pkcs1();
    std::vector<uint8_t> signature(kBlockBytes);
    DWORD signatureSize = 0;
    if (status == ERROR_SUCCESS) {
        status = NCryptSignHash(key.handle, &pkcs1, digest.data(), kDigestBytes, signature.data(), kBlockBytes,
                                &signatureSize, NCRYPT_PAD_PKCS1_FLAG | NCRYPT_SILENT_FLAG);
    }
    if (status == ERROR_SUCCESS && signatureSize != kBlockBytes) status = NTE_BAD_LEN;
    if (status != ERROR_SUCCESS) {
        key.Delete();
        return Outcome{Code(status), {}};
    }
    sealed.resize(kBlockBytes);
    sealed.insert(sealed.end(), signature.begin(), signature.end());
    return Outcome{0, std::move(sealed)};
}

Outcome Unseal(const Request& request) {
    std::wstring name = Wide(request.name);
    if (name.empty() || request.input.size() != 2 * kBlockBytes) return Outcome{kBadInput, {}};
    const uint8_t* ciphertext = request.input.data();
    const uint8_t* signature = request.input.data() + kBlockBytes;

    Provider provider;
    Key key;
    SECURITY_STATUS status = OpenKey(provider, key, name);
    if (status != ERROR_SUCCESS) return Outcome{Code(status), {}};

    std::vector<uint8_t> digest;
    status = Digest(ciphertext, digest);
    if (status != ERROR_SUCCESS) return Outcome{Code(status), {}};
    BCRYPT_PKCS1_PADDING_INFO pkcs1 = Pkcs1();
    status = NCryptVerifySignature(key.handle, &pkcs1, digest.data(), kDigestBytes, const_cast<PBYTE>(signature),
                                   kBlockBytes, NCRYPT_PAD_PKCS1_FLAG | NCRYPT_SILENT_FLAG);
    if (status == NTE_BAD_SIGNATURE) return Outcome{kTampered, {}};
    if (status != ERROR_SUCCESS) return Outcome{Code(status), {}};

    status = SetPin(key.handle, request.pin);
    if (status != ERROR_SUCCESS) return Outcome{Code(status), {}};

    std::vector<uint8_t> plain(kBlockBytes);
    BCRYPT_OAEP_PADDING_INFO padding = Oaep();
    DWORD size = 0;
    status = NCryptDecrypt(
        key.handle, const_cast<PBYTE>(ciphertext), kBlockBytes,
        &padding, plain.data(), static_cast<DWORD>(plain.size()), &size, NCRYPT_PAD_OAEP_FLAG | NCRYPT_SILENT_FLAG);
    if (status != ERROR_SUCCESS) {
        Scrub(plain);
        return Outcome{Code(status), {}};
    }
    plain.resize(size);
    return Outcome{0, std::move(plain)};
}

Outcome Remove(const Request& request) {
    std::wstring name = Wide(request.name);
    if (name.empty()) return Outcome{kBadInput, {}};

    Provider provider;
    Key key;
    SECURITY_STATUS status = OpenKey(provider, key, name);
    if (status == NTE_BAD_KEYSET || status == NTE_NOT_FOUND) return Outcome{0, {}};
    if (status != ERROR_SUCCESS) return Outcome{Code(status), {}};
    return Outcome{Code(key.Delete()), {}};
}

// Windows owns the lockout authorization and configures the lockout itself
Outcome Lockout(const Request&) {
    return Outcome{kUnimplemented, {}};
}

uint32_t Probe() {
    Provider provider;
    SECURITY_STATUS status = OpenProvider(provider);
    if (status != ERROR_SUCCESS) return Code(status);
    wchar_t platform[256] = {};
    DWORD size = 0;
    return Code(NCryptGetProperty(provider.handle, NCRYPT_PCP_PLATFORM_TYPE_PROPERTY,
                                  reinterpret_cast<PBYTE>(platform), sizeof(platform), &size, 0));
}

const char* PlatformName() {
    return "win";
}

}  // namespace vigil_tpm
