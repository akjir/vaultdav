import type { RemoteItem } from "../types";
import { util } from "../utilities";

const PROPFIND_XML_BODY: string = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<d:propfind xmlns:d="DAV:">',
    "    <d:prop>",
    "        <d:getlastmodified/>",
    "        <d:getcontentlength/>",
    "        <d:getetag/>",
    "        <d:resourcetype/>",
    "    </d:prop>",
    "</d:propfind>"
].join("\n");

export function buildPropfindBody(): string {
    return PROPFIND_XML_BODY;
}

export function findChildByLocalName(
    parent: Document | Element,
    localName: string
): Element | null {
    const matches: Element[] = findChildrenByLocalName(parent, localName);
    return matches[0] ?? null;
}

export function findChildrenByLocalName(
    parent: Document | Element,
    localName: string
): Element[] {
    const targetLower: string = localName.toLowerCase();
    const allElements: HTMLCollectionOf<Element> = parent.getElementsByTagName("*");
    const matched: Element[] = [];

    for (let i: number = 0; i < allElements.length; i += 1) {
        const element: Element | undefined = allElements[i];
        if (element === undefined) {
            continue;
        }
        const rawTag: string = element.tagName.toLowerCase();
        const colonIndex: number = rawTag.indexOf(":");
        const strippedTag: string = colonIndex === -1 ? rawTag : rawTag.slice(colonIndex + 1);
        const elemLocal: string = (element.localName || strippedTag).toLowerCase();
        if (elemLocal === targetLower || strippedTag === targetLower) {
            matched.push(element);
        }
    }
    return matched;
}

export function parseMultiStatus(
    xmlText: string,
    username: string,
    remoteBaseDir: string,
    queriedDirPath: string = ""
): RemoteItem[] {
    const parser: DOMParser = new DOMParser();
    const doc: Document = parser.parseFromString(xmlText, "application/xml");
    const parserError: Element | null = findChildByLocalName(doc, "parsererror");
    if (parserError !== null) {
        throw new Error(`Invalid WebDAV XML response: ${parserError.textContent ?? "parse error"}`);
    }

    const normalizedQueriedDir: string = util.normalizeVaultPath(queriedDirPath);
    const responses: Element[] = findChildrenByLocalName(doc, "response");
    const items: RemoteItem[] = [];

    for (const responseEl of responses) {
        const parsed: RemoteItem | null = parseResponseElement(
            responseEl,
            username,
            remoteBaseDir
        );
        if (parsed === null) {
            continue;
        }
        if (parsed.path === "" || parsed.path === normalizedQueriedDir) {
            continue;
        }
        items.push(parsed);
    }

    return items;
}

export function parseResponseElement(
    responseEl: Element,
    username: string,
    remoteBaseDir: string
): RemoteItem | null {
    const hrefEl: Element | null = findChildByLocalName(responseEl, "href");
    if (hrefEl === null || hrefEl.textContent === null) {
        return null;
    }

    const href: string = hrefEl.textContent.trim();
    const decodedPath: string | null = util.decodeWebDavHref(href, username, remoteBaseDir);
    if (decodedPath === null) {
        return null;
    }

    const propstats: Element[] = findChildrenByLocalName(responseEl, "propstat");
    let okPropEl: Element | null = null;

    for (const propstatEl of propstats) {
        const statusEl: Element | null = findChildByLocalName(propstatEl, "status");
        const statusText: string = statusEl?.textContent ?? "";
        if (statusText.includes(" 200 ")) {
            okPropEl = findChildByLocalName(propstatEl, "prop");
            if (okPropEl !== null) {
                break;
            }
        }
    }

    if (okPropEl === null) {
        return null;
    }

    const resourceTypeEl: Element | null = findChildByLocalName(okPropEl, "resourcetype");
    const collectionEl: Element | null =
        resourceTypeEl !== null ? findChildByLocalName(resourceTypeEl, "collection") : null;
    const isDirectory: boolean = collectionEl !== null;

    const etagEl: Element | null = findChildByLocalName(okPropEl, "getetag");
    const etag: string = util.normalizeEtag(etagEl?.textContent);

    const lastModifiedEl: Element | null = findChildByLocalName(okPropEl, "getlastmodified");
    const parsedTime: number =
        lastModifiedEl?.textContent !== undefined && lastModifiedEl.textContent !== null
            ? Date.parse(lastModifiedEl.textContent.trim())
            : 0;
    const mtime: number = Number.isFinite(parsedTime) && parsedTime > 0 ? parsedTime : 0;

    const contentLengthEl: Element | null = findChildByLocalName(okPropEl, "getcontentlength");
    const parsedSize: number =
        contentLengthEl?.textContent !== undefined && contentLengthEl.textContent !== null
            ? Number.parseInt(contentLengthEl.textContent.trim(), 10)
            : 0;
    const size: number =
        isDirectory || !Number.isFinite(parsedSize) || parsedSize < 0 ? 0 : parsedSize;

    return {
        etag,
        href,
        isDirectory,
        mtime,
        path: decodedPath,
        size
    };
}

export function parseSingleStat(
    xmlText: string,
    username: string,
    remoteBaseDir: string,
    targetPath: string
): RemoteItem | null {
    const parser: DOMParser = new DOMParser();
    const doc: Document = parser.parseFromString(xmlText, "application/xml");
    const parserError: Element | null = findChildByLocalName(doc, "parsererror");
    if (parserError !== null) {
        throw new Error(`Invalid WebDAV XML response: ${parserError.textContent ?? "parse error"}`);
    }

    const normalizedTarget: string = util.normalizeVaultPath(targetPath);
    const responses: Element[] = findChildrenByLocalName(doc, "response");

    for (const responseEl of responses) {
        const parsed: RemoteItem | null = parseResponseElement(
            responseEl,
            username,
            remoteBaseDir
        );
        if (parsed !== null && parsed.path === normalizedTarget) {
            return parsed;
        }
    }
    return null;
}
