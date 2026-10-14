import type { RemoteItem } from "../types";
import { util } from "../utilities";

const DIGITS_ONLY_REGEX: RegExp = /^\d+$/;
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
const STATUS_OK_REGEX: RegExp = /^HTTP\/\d+(?:\.\d+)?\s+200(?:\s|$)/i;

export function buildPropfindBody(): string {
    return PROPFIND_XML_BODY;
}

export function findChildByLocalName(
    parent: Document | Element,
    localName: string
): Element | null {
    const targetLower: string = localName.toLowerCase();
    const allElements: HTMLCollectionOf<Element> = parent.getElementsByTagName("*");

    for (let i: number = 0; i < allElements.length; i += 1) {
        const element: Element | undefined = allElements[i];
        if (element !== undefined && getElementLocalName(element) === targetLower) {
            return element;
        }
    }
    return null;
}

function findChildInElements(
    parents: ReadonlyArray<Element>,
    localName: string
): Element | null {
    for (const parent of parents) {
        const found: Element | null = findChildByLocalName(parent, localName);
        if (found !== null) {
            return found;
        }
    }
    return null;
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
        if (element !== undefined && getElementLocalName(element) === targetLower) {
            matched.push(element);
        }
    }
    return matched;
}

function getElementLocalName(element: Element): string {
    const rawTag: string = (element.localName || element.tagName).toLowerCase();
    const colonIndex: number = rawTag.indexOf(":");
    return colonIndex === -1 ? rawTag : rawTag.slice(colonIndex + 1);
}

export function parseMultiStatus(
    xmlText: string,
    username: string,
    remoteBaseDir: string,
    queriedDirPath: string = ""
): RemoteItem[] {
    const doc: Document = parseXmlDocument(xmlText);
    const normalizedQueriedDir: string = util.normalizeVaultPath(queriedDirPath);
    const responses: Element[] = findChildrenByLocalName(doc, "response");
    const seenPaths: Set<string> = new Set<string>();
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
        if (
            parsed.path === "" ||
            parsed.path === normalizedQueriedDir ||
            seenPaths.has(parsed.path)
        ) {
            continue;
        }
        seenPaths.add(parsed.path);
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
    const decodedPath: string | null = util.decodeWebDavHref(
        href,
        username,
        remoteBaseDir
    );
    if (decodedPath === null) {
        return null;
    }

    const propstats: Element[] = findChildrenByLocalName(responseEl, "propstat");
    const okPropEls: Element[] = [];

    for (const propstatEl of propstats) {
        const statusEl: Element | null = findChildByLocalName(propstatEl, "status");
        const statusText: string = (statusEl?.textContent ?? "").trim();
        if (STATUS_OK_REGEX.test(statusText)) {
            const propEl: Element | null = findChildByLocalName(propstatEl, "prop");
            if (propEl !== null) {
                okPropEls.push(propEl);
            }
        }
    }

    if (okPropEls.length === 0) {
        return null;
    }

    const resourceTypeEl: Element | null = findChildInElements(okPropEls, "resourcetype");
    const collectionEl: Element | null =
        resourceTypeEl !== null
            ? findChildByLocalName(resourceTypeEl, "collection")
            : null;
    const isDirectory: boolean = collectionEl !== null;

    const etagEl: Element | null = findChildInElements(okPropEls, "getetag");
    const etag: string = util.normalizeEtag(etagEl?.textContent);

    const lastModifiedEl: Element | null = findChildInElements(
        okPropEls,
        "getlastmodified"
    );
    const parsedTime: number =
        lastModifiedEl?.textContent !== undefined && lastModifiedEl.textContent !== null
            ? Date.parse(lastModifiedEl.textContent.trim())
            : 0;
    const mtime: number =
        Number.isFinite(parsedTime) && parsedTime > 0 ? parsedTime : 0;

    const contentLengthEl: Element | null = findChildInElements(
        okPropEls,
        "getcontentlength"
    );
    const rawSize: string = (contentLengthEl?.textContent ?? "").trim();
    const parsedSize: number = DIGITS_ONLY_REGEX.test(rawSize)
        ? Number.parseInt(rawSize, 10)
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
    const doc: Document = parseXmlDocument(xmlText);
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

export function parseXmlDocument(xmlText: string): Document {
    if (xmlText.trim() === "") {
        throw new Error("Invalid WebDAV XML response: empty body");
    }

    const parser: DOMParser = new DOMParser();
    const doc: Document = parser.parseFromString(xmlText, "application/xml");
    const parserError: Element | null = findChildByLocalName(doc, "parsererror");
    if (parserError !== null) {
        throw new Error(
            `Invalid WebDAV XML response: ${parserError.textContent ?? "parse error"}`
        );
    }

    const rootEl: Element | null = doc.documentElement;
    if (rootEl === null || getElementLocalName(rootEl) !== "multistatus") {
        throw new Error("Invalid WebDAV XML response: missing multistatus root element");
    }

    return doc;
}
