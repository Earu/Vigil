#ifndef VIGIL_TPM_COMMON_H_
#define VIGIL_TPM_COMMON_H_

#include <napi.h>

#include <cstdint>
#include <string>
#include <vector>

#include "tpm_parse.h"

namespace vigil_tpm {

constexpr uint32_t kBadInput = 0xFFFFFFFE;
constexpr uint32_t kUnimplemented = 0xFFFFFFFF;

struct Outcome {
    uint32_t status = 0;
    std::vector<uint8_t> data;
};

struct Request {
    std::string name;
    std::string pin;
    std::vector<uint8_t> input;
};

using Operation = Outcome (*)(const Request&);

Outcome Seal(const Request& request);
Outcome Unseal(const Request& request);
Outcome Remove(const Request& request);
// Big-endian TPM2_PT_PERMANENT, TPM2_PT_MAX_AUTH_FAIL, TPM2_PT_LOCKOUT_INTERVAL
Outcome Lockout(const Request& request);
uint32_t Probe();
const char* PlatformName();

class Worker : public Napi::AsyncWorker {
public:
    Worker(Napi::Env env, Operation operation, Request request)
        : Napi::AsyncWorker(env),
          deferred_(Napi::Promise::Deferred::New(env)),
          operation_(operation),
          request_(std::move(request)) {}

    ~Worker() override {
        Scrub(request_.pin);
        Scrub(request_.input);
        Scrub(outcome_.data);
    }

    Napi::Promise Promise() { return deferred_.Promise(); }

protected:
    void Execute() override {
        if (operation_ != Remove && operation_ != Lockout && !IsPin(request_.pin)) {
            outcome_ = Outcome{kBadInput, {}};
        } else {
            outcome_ = operation_(request_);
        }
        Scrub(request_.pin);
        Scrub(request_.input);
    }

    void OnOK() override {
        Napi::Env env = Env();
        Napi::HandleScope scope(env);
        Napi::Object result = Napi::Object::New(env);
        result.Set("status", Napi::Number::New(env, static_cast<double>(outcome_.status)));
        if (outcome_.status == 0 && !outcome_.data.empty()) {
            result.Set("data", Napi::Buffer<uint8_t>::Copy(env, outcome_.data.data(), outcome_.data.size()));
        }
        Scrub(outcome_.data);
        deferred_.Resolve(result);
    }

private:
    Napi::Promise::Deferred deferred_;
    Operation operation_;
    Request request_;
    Outcome outcome_;
};

inline Napi::Value Queue(Napi::Env env, Operation operation, Request request) {
    auto* worker = new Worker(env, operation, std::move(request));
    worker->Queue();
    return worker->Promise();
}

inline std::vector<uint8_t> BufferBytes(const Napi::Value& value) {
    Napi::Buffer<uint8_t> buffer = value.As<Napi::Buffer<uint8_t>>();
    return std::vector<uint8_t>(buffer.Data(), buffer.Data() + buffer.Length());
}

inline Napi::Value Refuse(Napi::Env env, const char* usage) {
    Napi::TypeError::New(env, usage).ThrowAsJavaScriptException();
    return env.Undefined();
}

inline Napi::Value JsProbe(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), static_cast<double>(Probe()));
}

inline Napi::Value JsSeal(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[0].IsString() || !info[1].IsBuffer() || !info[2].IsString()) {
        return Refuse(env, "seal(name: string, data: Buffer, pin: string)");
    }
    return Queue(env, Seal, Request{info[0].As<Napi::String>().Utf8Value(), info[2].As<Napi::String>().Utf8Value(), BufferBytes(info[1])});
}

inline Napi::Value JsUnseal(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[0].IsString() || !info[1].IsString() || !info[2].IsBuffer()) {
        return Refuse(env, "unseal(name: string, pin: string, sealed: Buffer)");
    }
    return Queue(env, Unseal, Request{info[0].As<Napi::String>().Utf8Value(), info[1].As<Napi::String>().Utf8Value(), BufferBytes(info[2])});
}

inline Napi::Value JsRemove(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) return Refuse(env, "remove(name: string)");
    return Queue(env, Remove, Request{info[0].As<Napi::String>().Utf8Value(), std::string(), {}});
}

inline Napi::Value JsLockout(const Napi::CallbackInfo& info) {
    return Queue(info.Env(), Lockout, Request{});
}

inline Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("platform", Napi::String::New(env, PlatformName()));
    exports.Set("probe", Napi::Function::New(env, JsProbe));
    exports.Set("seal", Napi::Function::New(env, JsSeal));
    exports.Set("unseal", Napi::Function::New(env, JsUnseal));
    exports.Set("remove", Napi::Function::New(env, JsRemove));
    exports.Set("lockout", Napi::Function::New(env, JsLockout));
    return exports;
}

}  // namespace vigil_tpm

inline Napi::Object InitVigilTpm(Napi::Env env, Napi::Object exports) {
    return vigil_tpm::Init(env, exports);
}

NODE_API_MODULE(vigil_tpm, InitVigilTpm)

#endif
