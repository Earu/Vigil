#include <napi.h>
#include <windows.h>
#include <wincred.h>

Napi::Boolean IsWindowsHelloAvailable(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    // Your existing IsWindowsHelloAvailable code here
    return Napi::Boolean::New(env, true); // Replace with actual implementation
}

Napi::Boolean AuthenticateWithWindowsHello(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        throw Napi::Error::New(env, "String argument expected");
    }
    std::string message = info[0].As<Napi::String>().Utf8Value();
    // Your existing AuthenticateWithWindowsHello code here
    return Napi::Boolean::New(env, true); // Replace with actual implementation
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("isAvailable", Napi::Function::New(env, IsWindowsHelloAvailable));
    exports.Set("authenticate", Napi::Function::New(env, AuthenticateWithWindowsHello));
    return exports;
}

NODE_API_MODULE(windows_hello, Init)