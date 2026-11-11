#include <tss2/tss2_esys.h>
#include <tss2/tss2_mu.h>
#include <tss2/tss2_tctildr.h>

#include <cstring>

#include "tpm_common.h"

namespace vigil_tpm {

namespace {

// The kernel resource manager only. Without an explicit TCTI the loader falls
// back to tabrmd and then to simulators on localhost:2321, which any local
// user can listen on and so receive the PIN and the sealed key
constexpr const char* kTcti = "device:/dev/tpmrm0";

class Context {
public:
    Context() {
        status_ = Tss2_TctiLdr_Initialize(kTcti, &tcti_);
        if (status_ == TSS2_RC_SUCCESS) status_ = Esys_Initialize(&context_, tcti_, nullptr);
    }

    ~Context() {
        if (context_ != nullptr) {
            for (auto it = handles_.rbegin(); it != handles_.rend(); ++it) Esys_FlushContext(context_, *it);
            Esys_Finalize(&context_);
        }
        if (tcti_ != nullptr) Tss2_TctiLdr_Finalize(&tcti_);
    }

    TSS2_RC status() const { return status_; }
    ESYS_CONTEXT* get() { return context_; }
    void Track(ESYS_TR handle) { handles_.push_back(handle); }

private:
    TSS2_TCTI_CONTEXT* tcti_ = nullptr;
    ESYS_CONTEXT* context_ = nullptr;
    TSS2_RC status_ = 0;
    std::vector<ESYS_TR> handles_;
};

TSS2_RC CreatePrimary(Context& context, ESYS_TR* primary) {
    TPM2B_SENSITIVE_CREATE sensitive = {};
    TPM2B_PUBLIC templ = {};
    templ.publicArea.type = TPM2_ALG_ECC;
    templ.publicArea.nameAlg = TPM2_ALG_SHA256;
    templ.publicArea.objectAttributes = TPMA_OBJECT_USERWITHAUTH | TPMA_OBJECT_RESTRICTED | TPMA_OBJECT_DECRYPT |
                                        TPMA_OBJECT_FIXEDTPM | TPMA_OBJECT_FIXEDPARENT |
                                        TPMA_OBJECT_SENSITIVEDATAORIGIN | TPMA_OBJECT_NODA;
    templ.publicArea.parameters.eccDetail.symmetric.algorithm = TPM2_ALG_AES;
    templ.publicArea.parameters.eccDetail.symmetric.keyBits.aes = 128;
    templ.publicArea.parameters.eccDetail.symmetric.mode.aes = TPM2_ALG_CFB;
    templ.publicArea.parameters.eccDetail.scheme.scheme = TPM2_ALG_NULL;
    templ.publicArea.parameters.eccDetail.curveID = TPM2_ECC_NIST_P256;
    templ.publicArea.parameters.eccDetail.kdf.scheme = TPM2_ALG_NULL;
    templ.publicArea.unique.ecc.x.size = 32;
    templ.publicArea.unique.ecc.y.size = 32;
    TPM2B_DATA outside = {};
    TPML_PCR_SELECTION pcrs = {};

    TSS2_RC status = Esys_CreatePrimary(context.get(), ESYS_TR_RH_OWNER, ESYS_TR_PASSWORD, ESYS_TR_NONE, ESYS_TR_NONE,
                                        &sensitive, &templ, &outside, &pcrs, primary,
                                        nullptr, nullptr, nullptr, nullptr);
    if (status == TSS2_RC_SUCCESS) context.Track(*primary);
    return status;
}

TSS2_RC StartSession(Context& context, ESYS_TR salt, TPMA_SESSION attributes, ESYS_TR* session) {
    TPMT_SYM_DEF symmetric = {};
    symmetric.algorithm = TPM2_ALG_AES;
    symmetric.keyBits.aes = 128;
    symmetric.mode.aes = TPM2_ALG_CFB;
    TSS2_RC status = Esys_StartAuthSession(context.get(), salt, ESYS_TR_NONE, ESYS_TR_NONE, ESYS_TR_NONE, ESYS_TR_NONE,
                                           nullptr, TPM2_SE_HMAC, &symmetric, TPM2_ALG_SHA256, session);
    if (status != TSS2_RC_SUCCESS) return status;
    context.Track(*session);
    return Esys_TRSess_SetAttributes(context.get(), *session, attributes | TPMA_SESSION_CONTINUESESSION, 0xff);
}

bool SetAuth(TPM2B_AUTH& auth, const std::string& pin) {
    if (!IsPin(pin) || pin.size() > sizeof(auth.buffer)) return false;
    auth.size = static_cast<UINT16>(pin.size());
    std::memcpy(auth.buffer, pin.data(), pin.size());
    return true;
}

void ScrubStruct(void* data, size_t size) {
    volatile uint8_t* p = static_cast<uint8_t*>(data);
    for (size_t i = 0; i < size; ++i) p[i] = 0;
}

}  // namespace

Outcome Seal(const Request& request) {
    if (!IsSecret(request.input) || request.input.size() > TPM2_MAX_SYM_DATA) return Outcome{kBadInput, {}};

    TPM2B_SENSITIVE_CREATE sensitive = {};
    if (!SetAuth(sensitive.sensitive.userAuth, request.pin)) return Outcome{kBadInput, {}};
    sensitive.sensitive.data.size = static_cast<UINT16>(request.input.size());
    std::memcpy(sensitive.sensitive.data.buffer, request.input.data(), request.input.size());

    TPM2B_PUBLIC templ = {};
    templ.publicArea.type = TPM2_ALG_KEYEDHASH;
    templ.publicArea.nameAlg = TPM2_ALG_SHA256;
    templ.publicArea.objectAttributes = TPMA_OBJECT_FIXEDTPM | TPMA_OBJECT_FIXEDPARENT | TPMA_OBJECT_USERWITHAUTH;
    templ.publicArea.parameters.keyedHashDetail.scheme.scheme = TPM2_ALG_NULL;
    TPM2B_DATA outside = {};
    TPML_PCR_SELECTION pcrs = {};

    Context context;
    TSS2_RC status = context.status();
    ESYS_TR primary = ESYS_TR_NONE;
    ESYS_TR session = ESYS_TR_NONE;
    if (status == TSS2_RC_SUCCESS) status = CreatePrimary(context, &primary);
    if (status == TSS2_RC_SUCCESS) status = StartSession(context, primary, TPMA_SESSION_DECRYPT, &session);

    TPM2B_PRIVATE* outPrivate = nullptr;
    TPM2B_PUBLIC* outPublic = nullptr;
    if (status == TSS2_RC_SUCCESS) {
        status = Esys_Create(context.get(), primary, session, ESYS_TR_NONE, ESYS_TR_NONE,
                             &sensitive, &templ, &outside, &pcrs, &outPrivate, &outPublic,
                             nullptr, nullptr, nullptr);
    }
    ScrubStruct(&sensitive, sizeof(sensitive));
    if (status != TSS2_RC_SUCCESS) return Outcome{status, {}};

    std::vector<uint8_t> sealed(sizeof(TPM2B_PRIVATE) + sizeof(TPM2B_PUBLIC));
    size_t offset = 0;
    status = Tss2_MU_TPM2B_PRIVATE_Marshal(outPrivate, sealed.data(), sealed.size(), &offset);
    if (status == TSS2_RC_SUCCESS) status = Tss2_MU_TPM2B_PUBLIC_Marshal(outPublic, sealed.data(), sealed.size(), &offset);
    Esys_Free(outPrivate);
    Esys_Free(outPublic);
    if (status != TSS2_RC_SUCCESS) return Outcome{status, {}};
    sealed.resize(offset);
    return Outcome{0, std::move(sealed)};
}

Outcome Unseal(const Request& request) {
    TPM2B_PRIVATE inPrivate = {};
    TPM2B_PUBLIC inPublic = {};
    Span privatePart;
    Span publicPart;
    if (!SplitSealed(request.input.data(), request.input.size(), sizeof(inPrivate.buffer), sizeof(TPMT_PUBLIC),
                     &privatePart, &publicPart)) {
        return Outcome{kBadInput, {}};
    }
    size_t privateOffset = 0;
    size_t publicOffset = 0;
    TSS2_RC status = Tss2_MU_TPM2B_PRIVATE_Unmarshal(request.input.data() + privatePart.offset, privatePart.size,
                                                     &privateOffset, &inPrivate);
    if (status == TSS2_RC_SUCCESS) {
        status = Tss2_MU_TPM2B_PUBLIC_Unmarshal(request.input.data() + publicPart.offset, publicPart.size,
                                                &publicOffset, &inPublic);
    }
    if (status != TSS2_RC_SUCCESS || privateOffset != privatePart.size || publicOffset != publicPart.size) {
        return Outcome{kBadInput, {}};
    }

    TPM2B_AUTH auth = {};
    if (!SetAuth(auth, request.pin)) return Outcome{kBadInput, {}};

    Context context;
    status = context.status();
    ESYS_TR primary = ESYS_TR_NONE;
    ESYS_TR object = ESYS_TR_NONE;
    if (status == TSS2_RC_SUCCESS) status = CreatePrimary(context, &primary);
    if (status == TSS2_RC_SUCCESS) {
        status = Esys_Load(context.get(), primary, ESYS_TR_PASSWORD, ESYS_TR_NONE, ESYS_TR_NONE, &inPrivate, &inPublic, &object);
        if (status == TSS2_RC_SUCCESS) context.Track(object);
    }
    if (status == TSS2_RC_SUCCESS) status = Esys_TR_SetAuth(context.get(), object, &auth);
    ScrubStruct(&auth, sizeof(auth));

    ESYS_TR session = ESYS_TR_NONE;
    if (status == TSS2_RC_SUCCESS) status = StartSession(context, primary, TPMA_SESSION_ENCRYPT, &session);

    TPM2B_SENSITIVE_DATA* outData = nullptr;
    if (status == TSS2_RC_SUCCESS) {
        status = Esys_Unseal(context.get(), object, session, ESYS_TR_NONE, ESYS_TR_NONE, &outData);
    }
    if (status != TSS2_RC_SUCCESS) return Outcome{status, {}};

    std::vector<uint8_t> plain(outData->buffer, outData->buffer + outData->size);
    ScrubStruct(outData, sizeof(*outData));
    Esys_Free(outData);
    return Outcome{0, std::move(plain)};
}

Outcome Remove(const Request&) {
    return Outcome{0, {}};
}

namespace {

TSS2_RC ReadProperty(Context& context, TPM2_PT property, uint32_t* value) {
    TPMI_YES_NO more = TPM2_NO;
    TPMS_CAPABILITY_DATA* capability = nullptr;
    TSS2_RC status = Esys_GetCapability(context.get(), ESYS_TR_NONE, ESYS_TR_NONE, ESYS_TR_NONE,
                                        TPM2_CAP_TPM_PROPERTIES, property, 1, &more, &capability);
    if (status != TSS2_RC_SUCCESS) return status;
    const TPML_TAGGED_TPM_PROPERTY& list = capability->data.tpmProperties;
    const bool found = list.count >= 1 && list.tpmProperty[0].property == property;
    if (found) *value = list.tpmProperty[0].value;
    Esys_Free(capability);
    return found ? TSS2_RC_SUCCESS : kBadInput;
}

}  // namespace

Outcome Lockout(const Request&) {
    Context context;
    TSS2_RC status = context.status();
    if (status != TSS2_RC_SUCCESS) return Outcome{status, {}};

    std::vector<uint8_t> data;
    for (TPM2_PT property : {TPM2_PT_PERMANENT, TPM2_PT_MAX_AUTH_FAIL, TPM2_PT_LOCKOUT_INTERVAL,
                             TPM2_PT_LOCKOUT_RECOVERY, TPM2_PT_LOCKOUT_COUNTER}) {
        uint32_t value = 0;
        status = ReadProperty(context, property, &value);
        if (status != TSS2_RC_SUCCESS) return Outcome{status, {}};
        for (int shift = 24; shift >= 0; shift -= 8) data.push_back(static_cast<uint8_t>(value >> shift));
    }
    return Outcome{0, std::move(data)};
}

Outcome SetLockout(const Request& request) {
    constexpr size_t kMaxLockoutAuth = 32;
    if (request.input.empty() || request.input.size() > kMaxLockoutAuth) return Outcome{kBadInput, {}};
    TPM2B_AUTH auth = {};
    auth.size = static_cast<UINT16>(request.input.size());
    std::memcpy(auth.buffer, request.input.data(), request.input.size());

    Context context;
    TSS2_RC status = context.status();
    ESYS_TR primary = ESYS_TR_NONE;
    ESYS_TR session = ESYS_TR_NONE;
    if (status == TSS2_RC_SUCCESS) status = CreatePrimary(context, &primary);
    if (status == TSS2_RC_SUCCESS) status = StartSession(context, primary, 0, &session);
    if (status == TSS2_RC_SUCCESS && request.hasValues) {
        status = Esys_DictionaryAttackParameters(context.get(), ESYS_TR_RH_LOCKOUT, session, ESYS_TR_NONE, ESYS_TR_NONE,
                                                 request.values[0], request.values[1], request.values[2]);
    }
    if (status == TSS2_RC_SUCCESS) {
        status = Esys_TRSess_SetAttributes(context.get(), session, TPMA_SESSION_DECRYPT | TPMA_SESSION_CONTINUESESSION, 0xff);
    }
    if (status == TSS2_RC_SUCCESS) {
        status = Esys_HierarchyChangeAuth(context.get(), ESYS_TR_RH_LOCKOUT, session, ESYS_TR_NONE, ESYS_TR_NONE, &auth);
    }
    ScrubStruct(&auth, sizeof(auth));
    if (context.get() != nullptr) Esys_TR_SetAuth(context.get(), ESYS_TR_RH_LOCKOUT, &auth);
    return Outcome{status, {}};
}

uint32_t Probe() {
    Context context;
    return context.status();
}

const char* PlatformName() {
    return "linux";
}

}  // namespace vigil_tpm
