#include <napi.h>
#include <windows.h>
#include <wincred.h>
#include <webauthn.h>
#include <bcrypt.h>
#include <string>
#include <vector>
#include <random>

#pragma comment(lib, "webauthn.lib")
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "ncrypt.lib")
#pragma comment(lib, "bcrypt.lib")

namespace {
    // Helper function to generate a random challenge
    std::vector<BYTE> GenerateChallenge(size_t length) {
        std::vector<BYTE> challenge(length);
        std::random_device rd;
        std::mt19937 gen(rd());
        std::uniform_int_distribution<> dis(0, 255);
        for (size_t i = 0; i < length; i++) {
            challenge[i] = static_cast<BYTE>(dis(gen));
        }
        return challenge;
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

Napi::Boolean AuthenticateWithWindowsHello(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    try {
        if (info.Length() < 1 || !info[0].IsString()) {
            throw Napi::Error::New(env, "String argument expected");
        }

        std::string message = info[0].As<Napi::String>().Utf8Value();
        std::wstring wmessage = ToWideString(message);

        // Get the foreground window handle
        HWND hWnd = GetForegroundWindow();
        if (!hWnd) {
            throw Napi::Error::New(env, "Failed to get foreground window");
        }

        // Generate a random challenge
        auto challenge = GenerateChallenge(32);

        // Create client data
        WEBAUTHN_CLIENT_DATA clientData = {};
        clientData.dwVersion = WEBAUTHN_CLIENT_DATA_CURRENT_VERSION;
        clientData.pwszHashAlgId = WEBAUTHN_HASH_ALGORITHM_SHA_256;
        clientData.cbClientDataJSON = static_cast<DWORD>(message.size());
        clientData.pbClientDataJSON = reinterpret_cast<BYTE*>(const_cast<char*>(message.c_str()));

        // Set up assertion options
        WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS assertionOptions = {};
        assertionOptions.dwVersion = WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS_CURRENT_VERSION;
        assertionOptions.dwTimeoutMilliseconds = 30000;  // 30 seconds timeout
        assertionOptions.dwUserVerificationRequirement = WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED;

        // Make the authentication request
        ScopedAssertion assertion(nullptr);
        HRESULT hr = WebAuthNAuthenticatorGetAssertion(
            hWnd,                    // Window handle
            L"vigil",               // RP ID
            &clientData,            // Client data
            &assertionOptions,      // Assertion options
            assertion.put()         // Output assertion
        );

        if (FAILED(hr)) {
            if (hr == HRESULT_FROM_WIN32(ERROR_CANCELLED)) {
                return Napi::Boolean::New(env, false);  // User cancelled
            }
            throw Napi::Error::New(env, "Windows Hello authentication failed");
        }

        return Napi::Boolean::New(env, true);
    }
    catch (const std::exception& e) {
        throw Napi::Error::New(env, e.what());
    }
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("isAvailable", Napi::Function::New(env, IsWindowsHelloAvailable));
    exports.Set("authenticate", Napi::Function::New(env, AuthenticateWithWindowsHello));
    return exports;
}

NODE_API_MODULE(windows_hello, Init)