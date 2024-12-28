#include <napi.h>
#include <windows.h>
#include <wincred.h>
#include <webauthn.h>
#include <bcrypt.h>
#include <wincrypt.h>
#include <string>
#include <vector>
#include <random>
#include <nlohmann/json.hpp>
#include <iostream>  // Include iostream for logging

#pragma comment(lib, "webauthn.lib")
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "ncrypt.lib")
#pragma comment(lib, "bcrypt.lib")

using json = nlohmann::json;

namespace {
    // Helper function to generate a random challenge
    std::vector<BYTE> GenerateChallenge() {
        // Generate random bytes for the challenge (32 bytes for security)
        std::vector<BYTE> randomBytes(32);
        if (!SUCCEEDED(BCryptGenRandom(nullptr, randomBytes.data(), static_cast<ULONG>(randomBytes.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG))) {
            throw std::runtime_error("Failed to generate random bytes for challenge");
        }
        return randomBytes;
    }

    // Helper function to convert string to wide string
    std::wstring ToWideString(const std::string& str) {
        if (str.empty()) return std::wstring();
        int size_needed = MultiByteToWideChar(CP_UTF8, 0, &str[0], (int)str.size(), NULL, 0);
        std::wstring wstr(size_needed, 0);
        MultiByteToWideChar(CP_UTF8, 0, &str[0], (int)str.size(), &wstr[0], size_needed);
        return wstr;
    }

    // Helper function to clean up WebAuthn assertion
    class ScopedAssertion {
    public:
        explicit ScopedAssertion(PWEBAUTHN_ASSERTION assertion) : assertion_(assertion) {}
        ~ScopedAssertion() {
            if (assertion_) {
                WebAuthNFreeAssertion(assertion_);
            }
        }
        PWEBAUTHN_ASSERTION get() const { return assertion_; }
        PWEBAUTHN_ASSERTION* put() { return &assertion_; }
    private:
        PWEBAUTHN_ASSERTION assertion_;
        // Prevent copying
        ScopedAssertion(const ScopedAssertion&) = delete;
        ScopedAssertion& operator=(const ScopedAssertion&) = delete;
    };

    // Helper class to clean up WebAuthn credential
    class ScopedCredential {
    public:
        explicit ScopedCredential(PWEBAUTHN_CREDENTIAL_ATTESTATION credential) : credential_(credential) {}
        ~ScopedCredential() {
            if (credential_) {
                WebAuthNFreeCredentialAttestation(credential_);
            }
        }
        PWEBAUTHN_CREDENTIAL_ATTESTATION get() const { return credential_; }
        PWEBAUTHN_CREDENTIAL_ATTESTATION* put() { return &credential_; }
    private:
        PWEBAUTHN_CREDENTIAL_ATTESTATION credential_;
        ScopedCredential(const ScopedCredential&) = delete;
        ScopedCredential& operator=(const ScopedCredential&) = delete;
    };

    // Function to convert HRESULT to a readable string
    std::string HResultToString(HRESULT hr) {
        char* errorMsg = nullptr;
        FormatMessageA(
            FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
            nullptr,
            hr,
            MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
            reinterpret_cast<LPSTR>(&errorMsg),
            0,
            nullptr
        );
        std::string errorString = errorMsg ? errorMsg : "Unknown error";
        LocalFree(errorMsg);
        return errorString;
    }
}

Napi::Boolean IsWindowsHelloAvailable(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    try {
        BOOL isSupported = FALSE;
        HRESULT hr = WebAuthNIsUserVerifyingPlatformAuthenticatorAvailable(&isSupported);

        if (FAILED(hr)) {
            throw Napi::Error::New(env, "Failed to check Windows Hello availability");
        }

        return Napi::Boolean::New(env, isSupported == TRUE);
    }
    catch (const std::exception& e) {
        throw Napi::Error::New(env, e.what());
    }
}

class AuthenticateWorker : public Napi::AsyncWorker {
private:
    std::string message;
    bool result;
    HWND windowHandle;

public:
    static std::vector<BYTE> lastCredentialId;  // Store the last created credential ID

    AuthenticateWorker(const std::string& msg, HWND hWnd, Napi::Function& callback)
        : Napi::AsyncWorker(callback), message(msg), result(false), windowHandle(hWnd) {}

    void Execute() override {
        try {
            if (!windowHandle) {
                SetError("Invalid window handle");
                return;
            }

            // Generate a challenge with proper JSON format
            auto challenge = GenerateChallenge();

            // Create client data
            WEBAUTHN_CLIENT_DATA clientData = {};
            clientData.dwVersion = WEBAUTHN_CLIENT_DATA_CURRENT_VERSION;
            clientData.pwszHashAlgId = WEBAUTHN_HASH_ALGORITHM_SHA_256;
            clientData.cbClientDataJSON = static_cast<DWORD>(challenge.size());
            clientData.pbClientDataJSON = challenge.data();

            // Create RP information with a proper origin
            WEBAUTHN_RP_ENTITY_INFORMATION rpInfo = {};
            rpInfo.dwVersion = WEBAUTHN_RP_ENTITY_INFORMATION_CURRENT_VERSION;
            rpInfo.pwszId = L"vigil";
            rpInfo.pwszName = L"Vigil Password Manager";
            rpInfo.pwszIcon = nullptr;

            // Set up allowed credentials if we have a stored credential
            WEBAUTHN_CREDENTIAL_EX credential = {};
            WEBAUTHN_CREDENTIAL_LIST credentialList = {};
            PWEBAUTHN_CREDENTIAL_EX pCredential = nullptr;
            if (!lastCredentialId.empty()) {
                credential.dwVersion = WEBAUTHN_CREDENTIAL_CURRENT_VERSION;
                credential.cbId = static_cast<DWORD>(lastCredentialId.size());
                credential.pbId = lastCredentialId.data();
                credential.pwszCredentialType = WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY;

                pCredential = &credential;
                credentialList.cCredentials = 1;
                credentialList.ppCredentials = &pCredential;
            }

            // Set up assertion options with more specific requirements
            WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS assertionOptions = {};
            assertionOptions.dwVersion = WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS_CURRENT_VERSION;
            assertionOptions.dwTimeoutMilliseconds = 30000;  // 30 seconds timeout
            assertionOptions.dwUserVerificationRequirement = WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED;
            assertionOptions.dwAuthenticatorAttachment = WEBAUTHN_AUTHENTICATOR_ATTACHMENT_PLATFORM;
            assertionOptions.pCancellationId = nullptr;
            assertionOptions.pAllowCredentialList = lastCredentialId.empty() ? nullptr : &credentialList;
            assertionOptions.dwFlags = 0;
            assertionOptions.pwszU2fAppId = nullptr;

            // Make the authentication request
            ScopedAssertion assertion(nullptr);
            HRESULT hr = WebAuthNAuthenticatorGetAssertion(
                windowHandle,
                rpInfo.pwszId,
                &clientData,
                &assertionOptions,
                assertion.put()
            );

            if (FAILED(hr)) {
                if (hr == HRESULT_FROM_WIN32(ERROR_CANCELLED)) {
                    result = false;
                    return;
                }
                SetError("Windows Hello authentication failed: " + std::to_string(hr));
                return;
            }

            // Store the credential ID for future use
            if (assertion.get() && assertion.get()->Credential.cbId > 0) {
                lastCredentialId.assign(
                    assertion.get()->Credential.pbId,
                    assertion.get()->Credential.pbId + assertion.get()->Credential.cbId
                );
            }

            result = true;
        }
        catch (const std::exception& e) {
            SetError(e.what());
        }
    }

    void OnOK() override {
        Napi::HandleScope scope(Env());
        Callback().Call({Env().Null(), Napi::Boolean::New(Env(), result)});
    }
};

// Initialize the static member
std::vector<BYTE> AuthenticateWorker::lastCredentialId;

class RegisterWorker : public Napi::AsyncWorker {
private:
    std::string message;
    bool result;
    HWND windowHandle;
    std::vector<BYTE> credentialId;

public:
    RegisterWorker(const std::string& msg, HWND hWnd, Napi::Function& callback)
        : Napi::AsyncWorker(callback), message(msg), result(false), windowHandle(hWnd) {}

    void Execute() override {
        try {
            if (!windowHandle) {
                SetError("Invalid window handle");
                return;
            }

            // Log the start of the credential creation process
            std::cout << "Starting credential creation process..." << std::endl;

            // Generate a challenge
            auto challenge = GenerateChallenge();

            // Log the generated challenge
            std::cout << "Generated challenge: " << std::string(challenge.begin(), challenge.end()) << std::endl;

            // Create client data
            WEBAUTHN_CLIENT_DATA clientData = {};
            clientData.dwVersion = WEBAUTHN_CLIENT_DATA_CURRENT_VERSION;
            clientData.pwszHashAlgId = WEBAUTHN_HASH_ALGORITHM_SHA_256;
            clientData.cbClientDataJSON = static_cast<DWORD>(challenge.size());
            clientData.pbClientDataJSON = challenge.data();

            // Log client data creation
            std::cout << "Client data created." << std::endl;

            // Create RP information
            WEBAUTHN_RP_ENTITY_INFORMATION rpInfo = {};
            rpInfo.dwVersion = WEBAUTHN_RP_ENTITY_INFORMATION_CURRENT_VERSION;
            rpInfo.pwszId = L"localhost";
            rpInfo.pwszName = L"Vigil Password Manager";
            rpInfo.pwszIcon = nullptr;

            // Log RP information
            std::cout << "RP information set." << std::endl;

            // Create user information with proper byte representation
            std::string userId = "vigil-user-id";
            std::vector<BYTE> userIdBytes(userId.begin(), userId.end());

            WEBAUTHN_USER_ENTITY_INFORMATION userInfo = {};
            userInfo.dwVersion = WEBAUTHN_USER_ENTITY_INFORMATION_CURRENT_VERSION;
            userInfo.cbId = static_cast<DWORD>(userIdBytes.size());
            userInfo.pbId = userIdBytes.data();
            userInfo.pwszName = L"Vigil User";
            userInfo.pwszIcon = nullptr;
            userInfo.pwszDisplayName = L"Vigil User";

            // Log user information
            std::cout << "User information set." << std::endl;

            // Set up credential creation parameters with more specific settings
            WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS makeCredentialOptions = {};
            makeCredentialOptions.dwVersion = WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS_CURRENT_VERSION;
            makeCredentialOptions.dwTimeoutMilliseconds = 60000;
            makeCredentialOptions.dwAuthenticatorAttachment = WEBAUTHN_AUTHENTICATOR_ATTACHMENT_PLATFORM;
            makeCredentialOptions.dwUserVerificationRequirement = WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED;
            makeCredentialOptions.dwAttestationConveyancePreference = WEBAUTHN_ATTESTATION_CONVEYANCE_PREFERENCE_DIRECT;
            makeCredentialOptions.dwFlags = 0;
            makeCredentialOptions.pCancellationId = nullptr;
            makeCredentialOptions.pExcludeCredentialList = nullptr;
            makeCredentialOptions.dwEnterpriseAttestation = 0;
            makeCredentialOptions.bRequireResidentKey = false;

            // Log credential creation options
            std::cout << "Credential creation options set." << std::endl;

            // Set up credential parameters
            WEBAUTHN_COSE_CREDENTIAL_PARAMETER credentialParam = {};
            credentialParam.dwVersion = WEBAUTHN_COSE_CREDENTIAL_PARAMETER_CURRENT_VERSION;
            credentialParam.pwszCredentialType = WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY;
            credentialParam.lAlg = WEBAUTHN_COSE_ALGORITHM_ECDSA_P256_WITH_SHA256;

            WEBAUTHN_COSE_CREDENTIAL_PARAMETERS credParams = {};
            credParams.cCredentialParameters = 1;
            credParams.pCredentialParameters = &credentialParam;

            // Log credential parameters
            std::cout << "Credential parameters set." << std::endl;

            // Add logging to capture parameters
            std::wcout << L"RP ID: " << rpInfo.pwszId << std::endl;
            std::wcout << L"User ID: " << std::wstring(userInfo.pbId, userInfo.pbId + userInfo.cbId) << std::endl;
            std::wcout << L"Credential Type: " << credentialParam.pwszCredentialType << std::endl;
            std::cout << "Algorithm: " << credentialParam.lAlg << std::endl;

            // Create the credential
            ScopedCredential credential(nullptr);
            HRESULT hr = WebAuthNAuthenticatorMakeCredential(
                windowHandle,
                &rpInfo,
                &userInfo,
                &credParams,
                &clientData,
                &makeCredentialOptions,
                credential.put()
            );

            // Log the result of credential creation
            if (FAILED(hr)) {
                std::cout << "Credential creation failed with HRESULT: " << hr << " - " << HResultToString(hr) << std::endl;
                if (hr == HRESULT_FROM_WIN32(ERROR_CANCELLED)) {
                    result = false;
                    return;
                }
                SetError("Windows Hello credential creation failed: " + std::to_string(hr));
                return;
            }

            // Store the credential ID for later use
            credentialId.assign(
                credential.get()->pbCredentialId,
                credential.get()->pbCredentialId + credential.get()->cbCredentialId
            );

            // Log successful credential creation
            std::cout << "Credential created successfully." << std::endl;

            result = true;
        }
        catch (const std::exception& e) {
            SetError(e.what());
        }
    }

    void OnOK() override {
        Napi::HandleScope scope(Env());
        if (result && !credentialId.empty()) {
            AuthenticateWorker::lastCredentialId = credentialId;
        }
        Callback().Call({Env().Null(), Napi::Boolean::New(Env(), result)});
    }
};

Napi::Value AuthenticateWithWindowsHello(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsFunction()) {
        throw Napi::Error::New(env, "Expected string and callback arguments");
    }

    std::string message = info[0].As<Napi::String>().Utf8Value();
    Napi::Function callback = info[1].As<Napi::Function>();

    // Get the window handle on the main thread
    HWND hWnd = GetForegroundWindow();
    if (!hWnd) {
        throw Napi::Error::New(env, "Failed to get foreground window");
    }

    AuthenticateWorker* worker = new AuthenticateWorker(message, hWnd, callback);
    worker->Queue();
    return env.Undefined();
}

Napi::Value RegisterWithWindowsHello(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsFunction()) {
        throw Napi::Error::New(env, "Expected string and callback arguments");
    }

    std::string message = info[0].As<Napi::String>().Utf8Value();
    Napi::Function callback = info[1].As<Napi::Function>();

    HWND hWnd = GetForegroundWindow();
    if (!hWnd) {
        throw Napi::Error::New(env, "Failed to get foreground window");
    }

    RegisterWorker* worker = new RegisterWorker(message, hWnd, callback);
    worker->Queue();
    return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("isAvailable", Napi::Function::New(env, IsWindowsHelloAvailable));
    exports.Set("register", Napi::Function::New(env, RegisterWithWindowsHello));
    exports.Set("authenticate", Napi::Function::New(env, AuthenticateWithWindowsHello));
    return exports;
}

NODE_API_MODULE(windows_hello, Init)