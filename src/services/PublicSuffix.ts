// The public suffix list, and the one question the app asks it: where does
// one party's control of a name end and an unrelated party's begin.
//
// Two callers, for the same reason in two protocols. A passkey RP ID may not
// be a public suffix, or a page could register a credential under "com" and
// be offered it on every other .com site. Autofill matching offers an entry
// on subdomains of its host, which assumes whoever holds the host holds
// everything under it: true of a registrable domain, false of a name that
// unrelated parties register under.
//
// 125 KB minified, for a check that runs once per passkey ceremony and once
// per candidate entry on a page load. Fetched on first use rather than
// carried in the startup chunk, the way the strength estimator is

let suffixList: Promise<typeof import('tldts')> | null = null;

export const loadSuffixList = (): Promise<typeof import('tldts')> => {
    if (!suffixList) {
        suffixList = import('tldts');
        // A failed chunk load retries on the next call
        suffixList.catch(() => { suffixList = null; });
    }
    return suffixList;
};

// Whether a host is a public suffix (com, co.uk, github.io): a name under
// which unrelated parties register, so nothing can claim it as its own.
// Private-section entries count, since user.github.io and other.github.io
// are as unrelated as two .com sites. A host the list knows nothing about
// (an IP address) is treated as one too, which fails closed
export async function isPublicSuffix(host: string): Promise<boolean> {
    const { getPublicSuffix } = await loadSuffixList();
    const suffix = getPublicSuffix(host, { allowPrivateDomains: true });
    return suffix === null || suffix === host;
}
