// Biometry-gated keychain storage for Vigil (macOS).
//
// Stores a secret as a keychain item protected by SecAccessControl
// (BiometryCurrentSet OR DevicePasscode); reading it makes the OS run a
// Touch ID (or passcode) check and only then release the data. The item
// lives in the data protection keychain: passing kSecAttrAccessControl
// routes there implicitly, and we ask for it explicitly so the behaviour
// is not left to Security framework heuristics.
// Modeled on KeePassXC's src/quickunlock/TouchID.mm.
//
// REQUIRES a build signed with application-identifier + keychain-access-groups
// entitlements authorized by a provisioning profile (see ../README.md).
// Without them every call reports errSecMissingEntitlement (-34018) and the
// JS layer falls back.
//
// The native surface is deliberately tiny: five operations, raw OSStatus
// out, all interpretation lives in ../index.js where it can be unit tested.

#include <napi.h>

#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <Security/Security.h>

#include <string>
#include <vector>

namespace {

const char* kServiceName = "Vigil Biometric Key";

// Overwrite key material before the vector's storage goes back to the heap.
// Written through a volatile pointer so the compiler cannot drop the stores
// as dead writes, which is exactly what it may do to a plain memset here
void Scrub(std::vector<uint8_t>& buffer) {
    volatile uint8_t* p = buffer.data();
    for (size_t i = 0; i < buffer.size(); ++i) {
        p[i] = 0;
    }
    buffer.clear();
}

NSString* ToNSString(const std::string& value) {
    NSString* result = [[NSString alloc] initWithBytes:value.data()
                                                length:value.size()
                                              encoding:NSUTF8StringEncoding];
    return result != nil ? result : @"";
}

NSMutableDictionary* MakeBaseQuery(const std::string& account) {
    return [@{
        (__bridge id) kSecClass: (__bridge id) kSecClassGenericPassword,
        (__bridge id) kSecAttrService: @(kServiceName),
        (__bridge id) kSecAttrAccount: ToNSString(account),
        (__bridge id) kSecUseDataProtectionKeychain: @YES,
    } mutableCopy];
}

// A context that must not put anything on screen. Used for the operations
// that only touch item metadata (existence check, delete, pre-write cleanup):
// those must never surprise the user with a Touch ID prompt
LAContext* SilentContext() {
    LAContext* context = [[LAContext alloc] init];
    context.interactionNotAllowed = YES;
    return context;
}

// Deleting an item is not an access of its payload, so it is expected to go
// through without authentication. That is not contractual though, and a
// silent context turns "would have prompted" into an error rather than a
// prompt. Prefer the silent attempt, but take the prompt over leaving a
// biometry-gated key behind for a database the user just turned unlock off for
OSStatus DeleteItem(const std::string& account) {
    NSMutableDictionary* query = MakeBaseQuery(account);
    query[(__bridge id) kSecUseAuthenticationContext] = SilentContext();
    OSStatus status = SecItemDelete((__bridge CFDictionaryRef) query);
    if (status == errSecInteractionNotAllowed) {
        NSMutableDictionary* retry = MakeBaseQuery(account);
        status = SecItemDelete((__bridge CFDictionaryRef) retry);
    }
    return status;
}

enum class Op { Set, Get, Delete, Has };

// One worker for all operations so the threading pattern exists once.
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

    ~KeychainWorker() override {
        Scrub(data_);
        Scrub(result_);
    }

    Napi::Promise Promise() { return deferred_.Promise(); }

protected:
    void Execute() override {
        @autoreleasepool {
            switch (op_) {
                case Op::Set: status_ = DoSet(); break;
                case Op::Get: status_ = DoGet(); break;
                case Op::Delete: status_ = DoDelete(); break;
                case Op::Has: status_ = DoHas(); break;
            }
        }
        Scrub(data_);
    }

    void OnOK() override {
        Napi::Env env = Env();
        Napi::HandleScope scope(env);
        Napi::Object result = Napi::Object::New(env);
        result.Set("status", Napi::Number::New(env, static_cast<double>(status_)));
        if (op_ == Op::Get && status_ == errSecSuccess) {
            result.Set("data", Napi::Buffer<uint8_t>::Copy(env, result_.data(), result_.size()));
        }
        Scrub(result_);
        deferred_.Resolve(result);
    }

private:
    OSStatus DoSet() {
        // Drop any previous item for this account, so re-enabling replaces
        // the key instead of failing with errSecDuplicateItem
        DeleteItem(account_);

        CFErrorRef aclError = NULL;
        SecAccessControlRef acl = SecAccessControlCreateWithFlags(
            kCFAllocatorDefault, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecAccessControlBiometryCurrentSet | kSecAccessControlOr | kSecAccessControlDevicePasscode,
            &aclError);
        if (acl == NULL || aclError != NULL) {
            if (aclError != NULL) CFRelease(aclError);
            if (acl != NULL) CFRelease(acl);
            return errSecParam;
        }

        NSMutableDictionary* attributes = MakeBaseQuery(account_);
        attributes[(__bridge id) kSecValueData] = [NSData dataWithBytes:data_.data() length:data_.size()];
        attributes[(__bridge id) kSecAttrSynchronizable] = @NO;
        attributes[(__bridge id) kSecAttrAccessControl] = (__bridge id) acl;
        // No silent context here on purpose. Creating the item is not normally
        // an access of it, but KeePassXC passes kSecUseAuthenticationUIAllow at
        // this exact point, so at least one configuration exists where macOS
        // wants the user. A prompt while enabling unlock is fine; failing to
        // store the key is not

        OSStatus status = SecItemAdd((__bridge CFDictionaryRef) attributes, NULL);
        CFRelease(acl);
        return status;
    }

    OSStatus DoGet() {
        NSMutableDictionary* query = MakeBaseQuery(account_);
        query[(__bridge id) kSecReturnData] = @YES;

        // kSecUseOperationPrompt is deprecated since macOS 11; the supported
        // way to word the prompt is an LAContext carrying localizedReason
        // The default fallback title is left alone so the system sheet keeps
        // offering the device passcode. The access control allows it, and it
        // is the only way through when biometry is enrolled but unavailable
        // (closed lid, unrecognised finger)
        LAContext* context = [[LAContext alloc] init];
        context.localizedReason = ToNSString(prompt_);
        query[(__bridge id) kSecUseAuthenticationContext] = context;

        CFTypeRef dataRef = NULL;
        OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef) query, &dataRef);

        if (status == errSecSuccess && dataRef != NULL) {
            NSData* data = (__bridge NSData*) dataRef;
            const uint8_t* bytes = static_cast<const uint8_t*>(data.bytes);
            result_.assign(bytes, bytes + data.length);
        }
        if (dataRef != NULL) CFRelease(dataRef);

        // Release the authenticated session as soon as the bytes are out.
        // touchIDAuthenticationAllowableReuseDuration is left at its default
        // of 0 anyway, this closes the window explicitly
        [context invalidate];
        return status;
    }

    OSStatus DoDelete() {
        return DeleteItem(account_);
    }

    // Presence check that must not prompt. Measured on an entitled build:
    // asking for attributes instead of kSecValueData still evaluates the
    // access control, so a matching item reports errSecInteractionNotAllowed
    // rather than success. That is the answer we want anyway, because the
    // status still separates the two cases: -25308 means an item matched and
    // would have needed the user, errSecItemNotFound means there is nothing
    // here. index.js turns that pair into a boolean
    OSStatus DoHas() {
        NSMutableDictionary* query = MakeBaseQuery(account_);
        query[(__bridge id) kSecReturnAttributes] = @YES;
        query[(__bridge id) kSecUseAuthenticationContext] = SilentContext();

        CFTypeRef attributes = NULL;
        OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef) query, &attributes);
        if (attributes != NULL) CFRelease(attributes);
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

// Synchronous: LAContext policy evaluation is a local capability check, it
// neither blocks nor shows UI
Napi::Value IsAvailable(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object result = Napi::Object::New(env);
    @autoreleasepool {
        LAContext* context = [[LAContext alloc] init];
        NSError* biometryError = nil;
        BOOL biometry = [context canEvaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics
                                             error:&biometryError];
        NSError* passcodeError = nil;
        BOOL passcode = [context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication
                                             error:&passcodeError];

        result.Set("biometry", Napi::Boolean::New(env, biometry));
        result.Set("devicePasscode", Napi::Boolean::New(env, passcode));
        // LABiometryTypeNone/TouchID/FaceID/OpticID; only meaningful once a
        // policy check has run, which the two calls above did
        result.Set("biometryType", Napi::Number::New(env, static_cast<double>(context.biometryType)));
        result.Set("error", Napi::Number::New(env,
            biometryError != nil ? static_cast<double>(biometryError.code) : 0));
    }
    return result;
}

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

Napi::Value HasSecret(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "hasSecret(account: string)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    auto* worker = new KeychainWorker(env, Op::Has, info[0].As<Napi::String>().Utf8Value(),
                                      std::vector<uint8_t>(), std::string());
    worker->Queue();
    return worker->Promise();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("isAvailable", Napi::Function::New(env, IsAvailable));
    exports.Set("setSecret", Napi::Function::New(env, SetSecret));
    exports.Set("getSecret", Napi::Function::New(env, GetSecret));
    exports.Set("deleteSecret", Napi::Function::New(env, DeleteSecret));
    exports.Set("hasSecret", Napi::Function::New(env, HasSecret));
    return exports;
}

}  // namespace

NODE_API_MODULE(vigil_touchid, Init)
