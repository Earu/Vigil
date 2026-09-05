// PC/SC (smart card) transport for Vigil.
//
// The OATH application on a YubiKey speaks ISO 7816 APDUs over the key's
// CCID interface, which every OS exposes through PC/SC: WinSCard on Windows,
// the PCSC framework on macOS, pcsclite on Linux. This addon is the smallest
// bridge to that API that the OATH driver needs: list readers, connect,
// transmit, transaction begin/end, disconnect. It knows nothing about
// YubiKeys or OATH; the protocol lives in electron/src/yubikey-oath.ts where
// it is tested against recorded responses.
//
// Every PC/SC call blocks (a transmit waits for a touch on the key for as
// long as the key allows), so each runs on a worker thread and resolves a
// promise. Results carry the raw return code as `rv`, normalised to its
// unsigned 32-bit value so 0x8010001D means the same thing on every
// platform; the mapping to names happens in ../index.js.
//
// Connections are tracked by an integer handle rather than a wrapped object,
// so the native surface stays a handful of functions. The handle table is
// touched only on the JS thread. A card handle must not see two calls in
// flight at once (PC/SC gives no guarantees there); index.js enforces that.

#include <napi.h>

#ifdef _WIN32
#include <windows.h>
#include <winscard.h>
#elif defined(__APPLE__)
#include <PCSC/winscard.h>
#include <PCSC/wintypes.h>
#else
#include <winscard.h>
#endif

#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace {

// Windows resolves these names to the wide variants when UNICODE is defined,
// which node-gyp's defaults may or may not do; the ANSI ones are wanted
#ifdef _WIN32
#define VIGIL_SCardListReaders SCardListReadersA
#define VIGIL_SCardConnect SCardConnectA
#else
#define VIGIL_SCardListReaders SCardListReaders
#define VIGIL_SCardConnect SCardConnect
#endif

// Largest response an extended-length APDU can carry, plus the status word
const DWORD kMaxResponse = 65538;

struct Session {
    SCARDCONTEXT context;
    SCARDHANDLE card;
    DWORD protocol;
};

std::map<uint32_t, Session> g_sessions;
uint32_t g_next_handle = 1;

// pcsclite's LONG is 64-bit, WinSCard's is 32; the codes are defined as
// 32-bit patterns in both, so this is the value the JS side keys on
double NormalizeRv(LONG rv) {
    return static_cast<double>(static_cast<uint32_t>(rv));
}

// Overwrite before the vector's storage goes back to the heap: a PUT's APDU
// carries an OTP secret. Written through a volatile pointer so the compiler
// cannot drop the stores as dead writes
void Scrub(std::vector<uint8_t>& buffer) {
    volatile uint8_t* p = buffer.data();
    for (size_t i = 0; i < buffer.size(); ++i) {
        p[i] = 0;
    }
    buffer.clear();
}

// A multi-string: NUL-separated names ending with a second NUL
std::vector<std::string> SplitMultiString(const std::vector<char>& buffer, DWORD length) {
    std::vector<std::string> names;
    size_t start = 0;
    const size_t end = length <= buffer.size() ? length : buffer.size();
    for (size_t i = 0; i < end; ++i) {
        if (buffer[i] != '\0') continue;
        if (i == start) break;
        names.emplace_back(buffer.data() + start, i - start);
        start = i + 1;
    }
    return names;
}

// One PC/SC call off the loop; resolves { rv, ...whatever Fill adds }
class PcscWorker : public Napi::AsyncWorker {
public:
    explicit PcscWorker(Napi::Env env)
        : Napi::AsyncWorker(env), rv_(SCARD_S_SUCCESS), deferred_(Napi::Promise::Deferred::New(env)) {}

    Napi::Promise Promise() { return deferred_.Promise(); }

protected:
    void OnOK() override {
        Napi::Env env = Env();
        Napi::HandleScope scope(env);
        Napi::Object result = Napi::Object::New(env);
        result.Set("rv", Napi::Number::New(env, NormalizeRv(rv_)));
        if (rv_ == SCARD_S_SUCCESS) Fill(env, result);
        deferred_.Resolve(result);
    }

    void OnError(const Napi::Error& error) override {
        deferred_.Reject(error.Value());
    }

    // Runs on the JS thread after a successful Execute
    virtual void Fill(Napi::Env env, Napi::Object& result) = 0;

    LONG rv_;

private:
    Napi::Promise::Deferred deferred_;
};

class ListReadersWorker : public PcscWorker {
public:
    using PcscWorker::PcscWorker;

protected:
    void Execute() override {
        SCARDCONTEXT context = 0;
        rv_ = SCardEstablishContext(SCARD_SCOPE_USER, nullptr, nullptr, &context);
        if (rv_ != SCARD_S_SUCCESS) return;

        for (int attempt = 0; attempt < 3; ++attempt) {
            DWORD length = 0;
            rv_ = VIGIL_SCardListReaders(context, nullptr, nullptr, &length);
            // No reader plugged in is an ordinary state, not a failure
            if (rv_ == static_cast<LONG>(SCARD_E_NO_READERS_AVAILABLE)) {
                rv_ = SCARD_S_SUCCESS;
                break;
            }
            if (rv_ != SCARD_S_SUCCESS || length == 0) break;
            std::vector<char> buffer(length);
            rv_ = VIGIL_SCardListReaders(context, nullptr, buffer.data(), &length);
            // A reader arrived between sizing and reading; size again
            if (rv_ == static_cast<LONG>(SCARD_E_INSUFFICIENT_BUFFER)) continue;
            if (rv_ == SCARD_S_SUCCESS) readers_ = SplitMultiString(buffer, length);
            break;
        }
        SCardReleaseContext(context);
    }

    void Fill(Napi::Env env, Napi::Object& result) override {
        Napi::Array readers = Napi::Array::New(env, readers_.size());
        for (size_t i = 0; i < readers_.size(); ++i) {
            readers.Set(static_cast<uint32_t>(i), Napi::String::New(env, readers_[i]));
        }
        result.Set("readers", readers);
    }

private:
    std::vector<std::string> readers_;
};

class ConnectWorker : public PcscWorker {
public:
    ConnectWorker(Napi::Env env, std::string reader, bool shared)
        : PcscWorker(env), reader_(std::move(reader)), shared_(shared), session_{0, 0, 0} {}

protected:
    void Execute() override {
        rv_ = SCardEstablishContext(SCARD_SCOPE_USER, nullptr, nullptr, &session_.context);
        if (rv_ != SCARD_S_SUCCESS) return;
        rv_ = VIGIL_SCardConnect(
            session_.context,
            reader_.c_str(),
            shared_ ? SCARD_SHARE_SHARED : SCARD_SHARE_EXCLUSIVE,
            SCARD_PROTOCOL_T0 | SCARD_PROTOCOL_T1,
            &session_.card,
            &session_.protocol);
        if (rv_ != SCARD_S_SUCCESS) SCardReleaseContext(session_.context);
    }

    void Fill(Napi::Env env, Napi::Object& result) override {
        const uint32_t handle = g_next_handle++;
        g_sessions[handle] = session_;
        result.Set("handle", Napi::Number::New(env, handle));
        result.Set("protocol", Napi::Number::New(env, static_cast<double>(session_.protocol)));
    }

private:
    std::string reader_;
    bool shared_;
    Session session_;
};

enum class CardOp { Transmit, BeginTransaction, EndTransaction, Disconnect };

class CardWorker : public PcscWorker {
public:
    CardWorker(Napi::Env env, uint32_t handle, Session session, CardOp op, std::vector<uint8_t> apdu)
        : PcscWorker(env), handle_(handle), session_(session), op_(op), apdu_(std::move(apdu)) {}

    // The worker deletes itself once the promise is settled; a PUT's secret
    // must not outlive it in freed memory
    ~CardWorker() override {
        Scrub(apdu_);
        Scrub(response_);
    }

protected:
    void Execute() override {
        switch (op_) {
            case CardOp::Transmit: {
                response_.resize(kMaxResponse);
                DWORD length = kMaxResponse;
                const SCARD_IO_REQUEST* pci =
                    session_.protocol == SCARD_PROTOCOL_T1 ? SCARD_PCI_T1 : SCARD_PCI_T0;
                rv_ = SCardTransmit(
                    session_.card, pci,
                    apdu_.data(), static_cast<DWORD>(apdu_.size()),
                    nullptr, response_.data(), &length);
                response_.resize(rv_ == SCARD_S_SUCCESS ? length : 0);
                break;
            }
            case CardOp::BeginTransaction:
                rv_ = SCardBeginTransaction(session_.card);
                break;
            case CardOp::EndTransaction:
                rv_ = SCardEndTransaction(session_.card, SCARD_LEAVE_CARD);
                break;
            case CardOp::Disconnect:
                // The context goes with the card whatever disconnect said:
                // the handle is unusable after this either way
                rv_ = SCardDisconnect(session_.card, SCARD_LEAVE_CARD);
                SCardReleaseContext(session_.context);
                break;
        }
    }

    void OnOK() override {
        // Forget the handle before resolving, and regardless of rv
        if (op_ == CardOp::Disconnect) g_sessions.erase(handle_);
        PcscWorker::OnOK();
    }

    void Fill(Napi::Env env, Napi::Object& result) override {
        if (op_ != CardOp::Transmit) return;
        result.Set("data", Napi::Buffer<uint8_t>::Copy(env, response_.data(), response_.size()));
    }

private:
    uint32_t handle_;
    Session session_;
    CardOp op_;
    std::vector<uint8_t> apdu_;
    std::vector<uint8_t> response_;
};

// ---- exports ----

Napi::Value ListReaders(const Napi::CallbackInfo& info) {
    auto* worker = new ListReadersWorker(info.Env());
    worker->Queue();
    return worker->Promise();
}

Napi::Value Connect(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsBoolean()) {
        Napi::TypeError::New(env, "connect(reader: string, shared: boolean)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    auto* worker = new ConnectWorker(env, info[0].As<Napi::String>().Utf8Value(), info[1].As<Napi::Boolean>().Value());
    worker->Queue();
    return worker->Promise();
}

// Looks the handle up on the JS thread and hands the worker a copy, so
// Execute never reads the table
Napi::Value CardCall(const Napi::CallbackInfo& info, CardOp op) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "expected a card handle").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const uint32_t handle = info[0].As<Napi::Number>().Uint32Value();
    auto found = g_sessions.find(handle);
    if (found == g_sessions.end()) {
        Napi::Error::New(env, "unknown card handle").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::vector<uint8_t> apdu;
    if (op == CardOp::Transmit) {
        if (info.Length() < 2 || !info[1].IsBuffer()) {
            Napi::TypeError::New(env, "transmit(handle, apdu: Buffer)").ThrowAsJavaScriptException();
            return env.Undefined();
        }
        auto buffer = info[1].As<Napi::Buffer<uint8_t>>();
        apdu.assign(buffer.Data(), buffer.Data() + buffer.Length());
    }

    auto* worker = new CardWorker(env, handle, found->second, op, std::move(apdu));
    worker->Queue();
    return worker->Promise();
}

Napi::Value Transmit(const Napi::CallbackInfo& info) { return CardCall(info, CardOp::Transmit); }
Napi::Value BeginTransaction(const Napi::CallbackInfo& info) { return CardCall(info, CardOp::BeginTransaction); }
Napi::Value EndTransaction(const Napi::CallbackInfo& info) { return CardCall(info, CardOp::EndTransaction); }
Napi::Value Disconnect(const Napi::CallbackInfo& info) { return CardCall(info, CardOp::Disconnect); }

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("listReaders", Napi::Function::New(env, ListReaders));
    exports.Set("connect", Napi::Function::New(env, Connect));
    exports.Set("transmit", Napi::Function::New(env, Transmit));
    exports.Set("beginTransaction", Napi::Function::New(env, BeginTransaction));
    exports.Set("endTransaction", Napi::Function::New(env, EndTransaction));
    exports.Set("disconnect", Napi::Function::New(env, Disconnect));
    return exports;
}

}  // namespace

NODE_API_MODULE(vigil_pcsc, Init)
