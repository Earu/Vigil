// Biometry-gated keychain storage for Vigil (macOS).
//
// Stores a secret as a data protection keychain item protected by
// SecAccessControl(BiometryCurrentSet OR DevicePasscode); reading it makes
// the OS run a Touch ID (or passcode) check and only then release the data.
// Modeled on KeePassXC's src/quickunlock/TouchID.mm.
//
// REQUIRES a build signed with application-identifier + keychain-access-groups
// entitlements authorized by a provisioning profile (see ../README.md).
// Without them every call reports errSecMissingEntitlement (-34018) and the
// JS layer falls back.
//
// The native surface is deliberately tiny: three operations, raw OSStatus
// out, all interpretation lives in ../index.js where it can be unit tested.

#include <napi.h>
#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>

#include <string>
#include <vector>

namespace {

const char* kServiceName = "Vigil Biometric Key";

CFStringRef MakeCFString(const std::string& value) {
    return CFStringCreateWithBytes(kCFAllocatorDefault,
                                   reinterpret_cast<const UInt8*>(value.data()),
                                   value.size(), kCFStringEncodingUTF8, false);
}

CFMutableDictionaryRef MakeBaseQuery(const std::string& account) {
    CFMutableDictionaryRef dict = CFDictionaryCreateMutable(
        kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFStringRef service = MakeCFString(kServiceName);
    CFStringRef accountRef = MakeCFString(account);
    CFDictionarySetValue(dict, kSecClass, kSecClassGenericPassword);
    CFDictionarySetValue(dict, kSecAttrService, service);
    CFDictionarySetValue(dict, kSecAttrAccount, accountRef);
    CFDictionarySetValue(dict, kSecUseDataProtectionKeychain, kCFBooleanTrue);
    CFRelease(service);
    CFRelease(accountRef);
    return dict;
}

enum class Op { Set, Get, Delete };

// One worker for all three operations so the threading pattern exists once.
// Execute runs off the main thread: SecItemCopyMatching blocks while the
// system shows the Touch ID prompt, and the Electron main process must keep
// pumping events during that
class KeychainWorker : public Napi::AsyncWorker {
public:
    KeychainWorker(Napi::Env env, Op op, std::string account,
                   std::vector<uint8_t> data, std::string prompt)
        : Napi::AsyncWorker(env),
          deferred_(Napi::Promise::Deferred::New(env)),
          op_(op),
          account_(std::move(account)),
          data_(std::move(data)),
          prompt_(std::move(prompt)) {}

    Napi::Promise Promise() { return deferred_.Promise(); }

protected:
    void Execute() override {
        switch (op_) {
            case Op::Set: status_ = DoSet(); break;
            case Op::Get: status_ = DoGet(); break;
            case Op::Delete: status_ = DoDelete(); break;
        }
    }

    void OnOK() override {
        Napi::Env env = Env();
        Napi::HandleScope scope(env);
        Napi::Object result = Napi::Object::New(env);
        result.Set("status", Napi::Number::New(env, static_cast<double>(status_)));
        if (op_ == Op::Get && status_ == errSecSuccess) {
            result.Set("data", Napi::Buffer<uint8_t>::Copy(env, result_.data(), result_.size()));
        }
        deferred_.Resolve(result);
    }

private:
    OSStatus DoSet() {
        // Replace any previous item for this account
        CFMutableDictionaryRef deleteQuery = MakeBaseQuery(account_);
        SecItemDelete(deleteQuery);
        CFRelease(deleteQuery);

        CFErrorRef aclError = nullptr;
        SecAccessControlRef acl = SecAccessControlCreateWithFlags(
            kCFAllocatorDefault, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecAccessControlBiometryCurrentSet | kSecAccessControlOr | kSecAccessControlDevicePasscode,
            &aclError);
        if (acl == nullptr || aclError != nullptr) {
            if (aclError != nullptr) CFRelease(aclError);
            if (acl != nullptr) CFRelease(acl);
            return errSecParam;
        }

        CFDataRef value = CFDataCreate(kCFAllocatorDefault, data_.data(), data_.size());
        CFMutableDictionaryRef attributes = MakeBaseQuery(account_);
        CFDictionarySetValue(attributes, kSecValueData, value);
        CFDictionarySetValue(attributes, kSecAttrSynchronizable, kCFBooleanFalse);
        CFDictionarySetValue(attributes, kSecAttrAccessControl, acl);

        OSStatus status = SecItemAdd(attributes, nullptr);
        CFRelease(attributes);
        CFRelease(value);
        CFRelease(acl);
        return status;
    }

    OSStatus DoGet() {
        CFMutableDictionaryRef query = MakeBaseQuery(account_);
        CFStringRef promptRef = MakeCFString(prompt_);
        CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
        CFDictionarySetValue(query, kSecUseOperationPrompt, promptRef);

        CFTypeRef dataRef = nullptr;
        OSStatus status = SecItemCopyMatching(query, &dataRef);
        CFRelease(query);
        CFRelease(promptRef);

        if (status == errSecSuccess && dataRef != nullptr) {
            CFDataRef data = static_cast<CFDataRef>(dataRef);
            const UInt8* bytes = CFDataGetBytePtr(data);
            result_.assign(bytes, bytes + CFDataGetLength(data));
        }
        if (dataRef != nullptr) CFRelease(dataRef);
        return status;
    }

    OSStatus DoDelete() {
        CFMutableDictionaryRef query = MakeBaseQuery(account_);
        OSStatus status = SecItemDelete(query);
        CFRelease(query);
        return status;
    }

    Napi::Promise::Deferred deferred_;
    Op op_;
    std::string account_;
    std::vector<uint8_t> data_;
    std::string prompt_;
    std::vector<uint8_t> result_;
    OSStatus status_ = errSecInternalError;
};

Napi::Value SetSecret(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsBuffer()) {
        Napi::TypeError::New(env, "setSecret(account: string, data: Buffer)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    Napi::Buffer<uint8_t> buffer = info[1].As<Napi::Buffer<uint8_t>>();
    std::vector<uint8_t> data(buffer.Data(), buffer.Data() + buffer.Length());
    auto* worker = new KeychainWorker(env, Op::Set, info[0].As<Napi::String>().Utf8Value(),
                                      std::move(data), std::string());
    worker->Queue();
    return worker->Promise();
}

Napi::Value GetSecret(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "getSecret(account: string, prompt: string)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    auto* worker = new KeychainWorker(env, Op::Get, info[0].As<Napi::String>().Utf8Value(),
                                      std::vector<uint8_t>(), info[1].As<Napi::String>().Utf8Value());
    worker->Queue();
    return worker->Promise();
}

Napi::Value DeleteSecret(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "deleteSecret(account: string)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    auto* worker = new KeychainWorker(env, Op::Delete, info[0].As<Napi::String>().Utf8Value(),
                                      std::vector<uint8_t>(), std::string());
    worker->Queue();
    return worker->Promise();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("setSecret", Napi::Function::New(env, SetSecret));
    exports.Set("getSecret", Napi::Function::New(env, GetSecret));
    exports.Set("deleteSecret", Napi::Function::New(env, DeleteSecret));
    return exports;
}

}  // namespace

NODE_API_MODULE(vigil_touchid, Init)
