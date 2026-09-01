// Non-macOS stub with the same surface, so the gyp/napi wiring can be
// compiled and exercised on any platform. Every operation reports
// errSecUnimplemented (-4); the JS layer treats that as unavailable.

#include <napi.h>

namespace {

Napi::Value Unimplemented(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);
    Napi::Object result = Napi::Object::New(env);
    result.Set("status", Napi::Number::New(env, -4));
    deferred.Resolve(result);
    return deferred.Promise();
}

// Mirrors the macOS shape so callers never branch on platform
Napi::Value IsAvailable(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object result = Napi::Object::New(env);
    result.Set("biometry", Napi::Boolean::New(env, false));
    result.Set("devicePasscode", Napi::Boolean::New(env, false));
    result.Set("biometryType", Napi::Number::New(env, 0));
    result.Set("error", Napi::Number::New(env, -4));
    return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("isAvailable", Napi::Function::New(env, IsAvailable));
    exports.Set("setSecret", Napi::Function::New(env, Unimplemented));
    exports.Set("getSecret", Napi::Function::New(env, Unimplemented));
    exports.Set("deleteSecret", Napi::Function::New(env, Unimplemented));
    exports.Set("hasSecret", Napi::Function::New(env, Unimplemented));
    return exports;
}

}  // namespace

NODE_API_MODULE(vigil_touchid, Init)
