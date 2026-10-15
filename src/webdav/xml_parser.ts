import type { RemoteItem } from "../types";
import { util } from "../utilities";

export const MAX_XML_BODY_LENGTH: number = 10 * 1024 * 1024;

const DIGITS_ONLY_REGEX: RegExp = /^\d+$/;
const DTD_OR_ENTITY_REGEX: RegExp = /<!\s*(?:DOCTYPE|ENTITY)\b/i;
const MAX_PARSER_ERROR_LENGTH: number = 200;
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
    let children: HTMLCollection | null = null;
    if ("documentElement" in parent) {
        const root: Element | null = parent.documentElement;
        if (root === null) {
            return null;
        }
        if (getElementLocalName(root) === targetLower) {
            return root;
        }
        children = root.children;
    } else {
        children = parent.children;
    }

    for (let i: number = 0; i < children.length; i += 1) {
        const element: Element | undefined = children[i];
        if (element !== undefined && getElementLocalName(element) === targetLower) {
            return element;
        }
    }
    return null;
}

export function findChildrenByLocalName(
    parent: Document | Element,
    localName: string
): Element[] {
    const targetLower: string = localName.toLowerCase();
    const matched: Element[] = [];
    let children: HTMLCollection | null = null;
    if ("documentElement" in parent) {
        const root: Element | null = parent.documentElement;
        if (root === null) {
            return matched;
        }
        if (getElementLocalName(root) === targetLower) {
            matched.push(root);
            return matched;
        }
        children = root.children;
    } else {
        children = parent.children;
    }

    for (let i: number = 0; i < children.length; i += 1) {
        const element: Element | undefined = children[i];
        if (element !== undefined && getElementLocalName(element) === targetLower) {
            matched.push(element);
        }
    }
    return matched;
}

function findEtagInElements(propElements: ReadonlyArray<Element>): string {
    for (const propEl of propElements) {
        const children: Element[] = findChildrenByLocalName(propEl, "getetag");
        for (const child of children) {
            const normalized: string = util.normalizeEtag(child.textContent);
            if (normalized !== "") {
                return normalized;
            }
        }
    }
    return "";
}

function findParserError(doc: Document): Element | null {
    const allElements: HTMLCollectionOf<Element> = doc.getElementsByTagName("*");
    for (let i: number = 0; i < allElements.length; i += 1) {
        const element: Element | undefined = allElements[i];
        if (element !== undefined && getElementLocalName(element) === "parsererror") {
            return element;
        }
    }
    return null;
}

function findPropertyTextInElements(
    propElements: ReadonlyArray<Element>,
    localName: string
): string {
    for (const propEl of propElements) {
        const children: Element[] = findChildrenByLocalName(propEl, localName);
        for (const child of children) {
            const text: string = (child.textContent ?? "").trim();
            if (text !== "") {
                return text;
            }
        }
    }
    return "";
}

function getElementLocalName(element: Element): string {
    const rawTag: string = (element.localName || element.tagName).toLowerCase();
    const colonIndex: number = rawTag.indexOf(":");
    return colonIndex === -1 ? rawTag : rawTag.slice(colonIndex + 1);
}

function hasCollectionResourceType(
    propElements: ReadonlyArray<Element>
): boolean {
    for (const propEl of propElements) {
        const resourceTypes: Element[] = findChildrenByLocalName(
            propEl,
            "resourcetype"
        );
        for (const resourceTypeEl of resourceTypes) {
            if (findChildByLocalName(resourceTypeEl, "collection") !== null) {
                return true;
            }
        }
    }
    return false;
}

function isExplicitRootPath(path: string): boolean {
    const trimmed: string = path.trim();
    return trimmed === "" || trimmed === "/";
}

export function parseMultiStatus(
    xmlText: string,
    username: string,
    remoteBaseDir: string,
    queriedDirPath: string = ""
): RemoteItem[] {
    const doc: Document = parseXmlDocument(xmlText);
    const normalizedBase: string = util.normalizeVaultPath(remoteBaseDir);
    if (normalizedBase === "" && !isExplicitRootPath(remoteBaseDir)) {
        throw new Error("Invalid WebDAV remote base directory path");
    }
    const normalizedQueriedDir: string = util.normalizeVaultPath(queriedDirPath);
    if (normalizedQueriedDir === "" && !isExplicitRootPath(queriedDirPath)) {
        throw new Error("Invalid WebDAV queried directory path");
    }
    const lowerQueriedDir: string = normalizedQueriedDir.toLowerCase();
    const responses: Element[] = findChildrenByLocalName(doc, "response");
    const seenPaths: Set<string> = new Set<string>();
    const items: RemoteItem[] = [];
    let inScopeCount: number = 0;

    for (const responseEl of responses) {
        const parsed: RemoteItem | null = parseResponseElement(
            responseEl,
            username,
            remoteBaseDir
        );
        if (parsed === null) {
            continue;
        }
        const lowerParsedPath: string = parsed.path.toLowerCase();
        if (
            parsed.path === normalizedQueriedDir ||
            lowerParsedPath === lowerQueriedDir
        ) {
            if (!parsed.isDirectory) {
                throw new Error(
                    "Invalid WebDAV XML response: queried path is not a directory"
                );
            }
            inScopeCount += 1;
            continue;
        }
        const parentPath: string = util.getParentPath(parsed.path);
        if (
            parsed.path === "" ||
            (parentPath !== normalizedQueriedDir &&
                parentPath.toLowerCase() !== lowerQueriedDir) ||
            seenPaths.has(parsed.path)
        ) {
            continue;
        }
        inScopeCount += 1;
        seenPaths.add(parsed.path);
        items.push(parsed);
    }

    if (inScopeCount === 0) {
        throw new Error(
            "Invalid WebDAV XML response: no in-scope responses for queried directory"
        );
    }

    return items;
}

export function parseResponseElement(
    responseEl: Element,
    username: string,
    remoteBaseDir: string
): RemoteItem | null {
    const normalizedBase: string = util.normalizeVaultPath(remoteBaseDir);
    if (normalizedBase === "" && !isExplicitRootPath(remoteBaseDir)) {
        return null;
    }

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

    const isDirectory: boolean = hasCollectionResourceType(okPropEls);
    const etag: string = findEtagInElements(okPropEls);

    const rawLastModified: string = findPropertyTextInElements(
        okPropEls,
        "getlastmodified"
    );
    const parsedTime: number =
        rawLastModified !== "" ? Date.parse(rawLastModified) : 0;
    const mtime: number =
        Number.isFinite(parsedTime) && parsedTime > 0
            ? util.toSecondPrecision(parsedTime)
            : 0;

    const rawSize: string = findPropertyTextInElements(
        okPropEls,
        "getcontentlength"
    );
    const parsedSize: number = DIGITS_ONLY_REGEX.test(rawSize)
        ? Number.parseInt(rawSize, 10)
        : 0;
    const size: number =
        isDirectory || !Number.isSafeInteger(parsedSize) || parsedSize < 0
            ? 0
            : parsedSize;

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
    const normalizedBase: string = util.normalizeVaultPath(remoteBaseDir);
    if (normalizedBase === "" && !isExplicitRootPath(remoteBaseDir)) {
        return null;
    }
    const normalizedTarget: string = util.normalizeVaultPath(targetPath);
    if (normalizedTarget === "" && !isExplicitRootPath(targetPath)) {
        return null;
    }
    const lowerTarget: string = normalizedTarget.toLowerCase();
    const responses: Element[] = findChildrenByLocalName(doc, "response");

    for (const responseEl of responses) {
        const parsed: RemoteItem | null = parseResponseElement(
            responseEl,
            username,
            remoteBaseDir
        );
        if (
            parsed !== null &&
            (parsed.path === normalizedTarget ||
                parsed.path.toLowerCase() === lowerTarget)
        ) {
            return parsed;
        }
    }
    return null;
}

export function parseXmlDocument(xmlText: string): Document {
    if (xmlText.length > MAX_XML_BODY_LENGTH) {
        throw new Error(
            `Invalid WebDAV XML response: payload exceeds maximum length (${MAX_XML_BODY_LENGTH} characters)`
        );
    }
    if (xmlText.trim() === "") {
        throw new Error("Invalid WebDAV XML response: empty body");
    }
    if (DTD_OR_ENTITY_REGEX.test(xmlText)) {
        throw new Error(
            "Invalid WebDAV XML response: DTD and ENTITY declarations are forbidden"
        );
    }

    const parser: DOMParser = new DOMParser();
    const doc: Document = parser.parseFromString(xmlText, "application/xml");
    const parserError: Element | null = findParserError(doc);
    if (parserError !== null) {
        const rawError: string = (parserError.textContent ?? "parse error").trim();
        const boundedError: string =
            rawError.length > MAX_PARSER_ERROR_LENGTH
                ? `${rawError.slice(0, MAX_PARSER_ERROR_LENGTH)}...`
                : rawError;
        throw new Error(`Invalid WebDAV XML response: ${boundedError}`);
    }

    const rootEl: Element | null = doc.documentElement;
    if (rootEl === null || getElementLocalName(rootEl) !== "multistatus") {
        throw new Error("Invalid WebDAV XML response: missing multistatus root element");
    }

    return doc;
}

