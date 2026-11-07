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

#include "touchid_parse.h"

namespace {

using vigil_touchid::Scrub;
using vigil_touchid::ToNSString;

enum class Kind { Biometry, Pin, State };

const char* ServiceName(Kind kind) {
    switch (kind) {
        case Kind::Biometry: return "Vigil Biometric Key";
        case Kind::Pin: return "Vigil PIN Key";
        case Kind::State: return "Vigil PIN State";
    }
    return "Vigil Biometric Key";
}

// nil for an account name that cannot be one, which every caller turns into
// errSecParam rather than carrying on against some other item
NSMutableDictionary* MakeBaseQuery(Kind kind, const std::string& account) {
    NSString* name = ToNSString(account);
    if (name == nil) return nil;
    return [@{
        (__bridge id) kSecClass: (__bridge id) kSecClassGenericPassword,
        (__bridge id) kSecAttrService: @(ServiceName(kind)),
        (__bridge id) kSecAttrAccount: name,
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

LAContext* PinContext(std::vector<uint8_t>& pin) {
    LAContext* context = SilentContext();
    NSData* credential = [NSData dataWithBytesNoCopy:pin.data() length:pin.size() freeWhenDone:NO];
    if (![context setCredential:credential type:LACredentialTypeApplicationPassword]) return nil;
    return context;
}

// Deleting an item is not an access of its payload, so it is expected to go
// through without authentication. That is not contractual though, and a
// silent context turns "would have prompted" into an error rather than a
// prompt. Prefer the silent attempt, but take the prompt over leaving a
// biometry-gated key behind for a database the user just turned unlock off for
OSStatus DeleteItem(Kind kind, const std::string& account) {
    NSMutableDictionary* query = MakeBaseQuery(kind, account);
    if (query == nil) return errSecParam;
    query[(__bridge id) kSecUseAuthenticationContext] = SilentContext();
    OSStatus status = SecItemDelete((__bridge CFDictionaryRef) query);
    if (status == errSecInteractionNotAllowed) {
        NSMutableDictionary* retry = MakeBaseQuery(kind, account);
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
    KeychainWorker(Napi::Env env, Op op, Kind kind, std::string account,
                   std::vector<uint8_t> data, std::string prompt, std::vector<uint8_t> pin)
        : Napi::AsyncWorker(env),
          deferred_(Napi::Promise::Deferred::New(env)),
          op_(op),
          kind_(kind),
          account_(std::move(account)),
          data_(std::move(data)),
          prompt_(std::move(prompt)),
          pin_(std::move(pin)) {}

    ~KeychainWorker() override {
        Scrub(data_);
        Scrub(pin_);
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
        Scrub(pin_);
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
        DeleteItem(kind_, account_);

        NSMutableDictionary* attributes = MakeBaseQuery(kind_, account_);
        if (attributes == nil) return errSecParam;
        attributes[(__bridge id) kSecValueData] = [NSData dataWithBytes:data_.data() length:data_.size()];
        attributes[(__bridge id) kSecAttrSynchronizable] = @NO;

        if (kind_ == Kind::State) {
            attributes[(__bridge id) kSecAttrAccessible] = (__bridge id) kSecAttrAccessibleWhenUnlockedThisDeviceOnly;
            return SecItemAdd((__bridge CFDictionaryRef) attributes, NULL);
        }

        SecAccessControlCreateFlags flags = kind_ == Kind::Pin
            ? kSecAccessControlApplicationPassword
            : kSecAccessControlBiometryCurrentSet | kSecAccessControlOr | kSecAccessControlDevicePasscode;
        CFErrorRef aclError = NULL;
        SecAccessControlRef acl = SecAccessControlCreateWithFlags(
            kCFAllocatorDefault, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, flags, &aclError);
        if (acl == NULL || aclError != NULL) {
            if (aclError != NULL) CFRelease(aclError);
            if (acl != NULL) CFRelease(acl);
            return errSecParam;
        }
        attributes[(__bridge id) kSecAttrAccessControl] = (__bridge id) acl;

        if (kind_ == Kind::Pin) {
            LAContext* context = PinContext(pin_);
            if (context == nil) {
                CFRelease(acl);
                return errSecParam;
            }
            attributes[(__bridge id) kSecUseAuthenticationContext] = context;
        }
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
        NSMutableDictionary* query = MakeBaseQuery(kind_, account_);
        if (query == nil) return errSecParam;
        query[(__bridge id) kSecReturnData] = @YES;

        LAContext* context = nil;
        if (kind_ == Kind::Pin) {
            context = PinContext(pin_);
            if (context == nil) return errSecParam;
        } else if (kind_ == Kind::State) {
            context = SilentContext();
        } else {
            // kSecUseOperationPrompt is deprecated since macOS 11; the supported
            // way to word the prompt is an LAContext carrying localizedReason
            // The default fallback title is left alone so the system sheet keeps
            // offering the device passcode. The access control allows it, and it
            // is the only way through when biometry is enrolled but unavailable
            // (closed lid, unrecognised finger)
            context = [[LAContext alloc] init];
            // A prompt that will not convert is only a wording problem, so the
            // system's own default is used rather than failing the unlock
            NSString* reason = ToNSString(prompt_);
            if (reason != nil) context.localizedReason = reason;
        }
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
        return DeleteItem(kind_, account_);
    }

    // Presence check that must not prompt. Measured on an entitled build:
    // asking for attributes instead of kSecValueData still evaluates the
    // access control, so a matching item reports errSecInteractionNotAllowed
    // rather than success. That is the answer we want anyway, because the
    // status still separates the two cases: -25308 means an item matched and
    // would have needed the user, errSecItemNotFound means there is nothing
    // here. index.js turns that pair into a boolean
    OSStatus DoHas() {
        NSMutableDictionary* query = MakeBaseQuery(kind_, account_);
        if (query == nil) return errSecParam;
        query[(__bridge id) kSecReturnAttributes] = @YES;
        query[(__bridge id) kSecUseAuthenticationContext] = SilentContext();

        CFTypeRef attributes = NULL;
        OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef) query, &attributes);
        if (attributes != NULL) CFRelease(attributes);
        return status;
    }

    Napi::Promise::Deferred deferred_;
    Op op_;
    Kind kind_;
    std::string account_;
    std::vector<uint8_t> data_;
    std::string prompt_;
    std::vector<uint8_t> pin_;
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

Napi::Value Queue(Napi::Env env, Op op, Kind kind, const Napi::Value& account,
                  std::vector<uint8_t> data, std::string prompt, std::vector<uint8_t> pin) {
    auto* worker = new KeychainWorker(env, op, kind, account.As<Napi::String>().Utf8Value(),
                                      std::move(data), std::move(prompt), std::move(pin));
    worker->Queue();
    return worker->Promise();
}

std::vector<uint8_t> BufferBytes(const Napi::Value& value) {
    Napi::Buffer<uint8_t> buffer = value.As<Napi::Buffer<uint8_t>>();
    return std::vector<uint8_t>(buffer.Data(), buffer.Data() + buffer.Length());
}

std::vector<uint8_t> StringBytes(const Napi::Value& value) {
    std::string text = value.As<Napi::String>().Utf8Value();
    return std::vector<uint8_t>(text.begin(), text.end());
}

Napi::Value Refuse(Napi::Env env, const char* usage) {
    Napi::TypeError::New(env, usage).ThrowAsJavaScriptException();
    return env.Undefined();
}

Napi::Value SetSecret(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsBuffer()) {
        return Refuse(env, "setSecret(account: string, data: Buffer)");
    }
    return Queue(env, Op::Set, Kind::Biometry, info[0], BufferBytes(info[1]), std::string(), {});
}

Napi::Value GetSecret(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        return Refuse(env, "getSecret(account: string, prompt: string)");
    }
    return Queue(env, Op::Get, Kind::Biometry, info[0], {}, info[1].As<Napi::String>().Utf8Value(), {});
}

Napi::Value DeleteSecret(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) return Refuse(env, "deleteSecret(account: string)");
    return Queue(env, Op::Delete, Kind::Biometry, info[0], {}, std::string(), {});
}

Napi::Value HasSecret(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) return Refuse(env, "hasSecret(account: string)");
    return Queue(env, Op::Has, Kind::Biometry, info[0], {}, std::string(), {});
}

Napi::Value SetPinSecret(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[0].IsString() || !info[1].IsBuffer() || !info[2].IsString()) {
        return Refuse(env, "setPinSecret(account: string, data: Buffer, pin: string)");
    }
    return Queue(env, Op::Set, Kind::Pin, info[0], BufferBytes(info[1]), std::string(), StringBytes(info[2]));
}

Napi::Value GetPinSecret(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        return Refuse(env, "getPinSecret(account: string, pin: string)");
    }
    return Queue(env, Op::Get, Kind::Pin, info[0], {}, std::string(), StringBytes(info[1]));
}

Napi::Value DeletePinSecret(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) return Refuse(env, "deletePinSecret(account: string)");
    return Queue(env, Op::Delete, Kind::Pin, info[0], {}, std::string(), {});
}

Napi::Value SetPinState(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsBuffer()) {
        return Refuse(env, "setPinState(account: string, data: Buffer)");
    }
    return Queue(env, Op::Set, Kind::State, info[0], BufferBytes(info[1]), std::string(), {});
}

Napi::Value GetPinState(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) return Refuse(env, "getPinState(account: string)");
    return Queue(env, Op::Get, Kind::State, info[0], {}, std::string(), {});
}

Napi::Value DeletePinState(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) return Refuse(env, "deletePinState(account: string)");
    return Queue(env, Op::Delete, Kind::State, info[0], {}, std::string(), {});
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("isAvailable", Napi::Function::New(env, IsAvailable));
    exports.Set("setSecret", Napi::Function::New(env, SetSecret));
    exports.Set("getSecret", Napi::Function::New(env, GetSecret));
    exports.Set("deleteSecret", Napi::Function::New(env, DeleteSecret));
    exports.Set("hasSecret", Napi::Function::New(env, HasSecret));
    exports.Set("setPinSecret", Napi::Function::New(env, SetPinSecret));
    exports.Set("getPinSecret", Napi::Function::New(env, GetPinSecret));
    exports.Set("deletePinSecret", Napi::Function::New(env, DeletePinSecret));
    exports.Set("setPinState", Napi::Function::New(env, SetPinState));
    exports.Set("getPinState", Napi::Function::New(env, GetPinState));
    exports.Set("deletePinState", Napi::Function::New(env, DeletePinState));
    return exports;
}

}  // namespace

NODE_API_MODULE(vigil_touchid, Init)
