import type { RequestUrlParam, RequestUrlResponse, RequestUrlResponsePromise } from "obsidian";

interface DomElementOptions {
    cls?: string | string[];
    text?: string;
}

function attachDomHelpers<T extends HTMLElement>(el: T): T {
    const target: HTMLElement & {
        addClass?: (...classes: string[]) => void;
        createDiv?: (opts?: DomElementOptions | string) => HTMLDivElement;
        createEl?: <K extends keyof HTMLElementTagNameMap>(
            tag: K,
            opts?: DomElementOptions | string
        ) => HTMLElementTagNameMap[K];
        createSpan?: (opts?: DomElementOptions | string) => HTMLSpanElement;
        empty?: () => void;
        removeClass?: (...classes: string[]) => void;
    } = el;

    if (typeof target.empty !== "function") {
        target.empty = (): void => {
            target.replaceChildren();
        };
    }
    if (typeof target.addClass !== "function") {
        target.addClass = (...classes: string[]): void => {
            for (const cls of classes) {
                for (const token of cls.split(/\s+/)) {
                    if (token !== "") {
                        target.classList.add(token);
                    }
                }
            }
        };
    }
    if (typeof target.removeClass !== "function") {
        target.removeClass = (...classes: string[]): void => {
            for (const cls of classes) {
                for (const token of cls.split(/\s+/)) {
                    if (token !== "") {
                        target.classList.remove(token);
                    }
                }
            }
        };
    }
    if (typeof target.createEl !== "function") {
        target.createEl = <K extends keyof HTMLElementTagNameMap>(
            tag: K,
            opts?: DomElementOptions | string
        ): HTMLElementTagNameMap[K] => {
            const child: HTMLElementTagNameMap[K] = attachDomHelpers(
                document.createElement(tag)
            );
            if (typeof opts === "string") {
                child.classList.add(...opts.split(/\s+/).filter(Boolean));
            } else if (opts !== undefined) {
                if (typeof opts.cls === "string") {
                    child.classList.add(...opts.cls.split(/\s+/).filter(Boolean));
                } else if (Array.isArray(opts.cls)) {
                    for (const token of opts.cls) {
                        if (token !== "") {
                            child.classList.add(token);
                        }
                    }
                }
                if (opts.text !== undefined) {
                    child.textContent = opts.text;
                }
            }
            target.appendChild(child);
            return child;
        };
    }
    if (typeof target.createDiv !== "function") {
        target.createDiv = (opts?: DomElementOptions | string): HTMLDivElement =>
            target.createEl!("div", opts);
    }
    if (typeof target.createSpan !== "function") {
        target.createSpan = (
            opts?: DomElementOptions | string
        ): HTMLSpanElement => target.createEl!("span", opts);
    }
    return el;
}

export class BaseComponent {
    public disabled: boolean = false;

    public setDisabled(disabled: boolean): this {
        this.disabled = disabled;
        return this;
    }
}

export class WorkspaceLeaf {
    public app: unknown;
    public view: unknown = null;
    public viewState: unknown = null;

    public constructor(app?: unknown) {
        this.app = app;
    }

    public async setViewState(state: unknown): Promise<void> {
        this.viewState = state;
        await Promise.resolve();
    }
}

export abstract class ItemView {
    public app: unknown;
    public containerEl: HTMLElement;
    public contentEl: HTMLElement;
    public leaf: WorkspaceLeaf;

    public constructor(leaf: WorkspaceLeaf) {
        this.leaf = leaf;
        this.app = leaf.app;
        this.containerEl = attachDomHelpers(document.createElement("div"));
        this.contentEl = attachDomHelpers(document.createElement("div"));
        this.containerEl.appendChild(this.contentEl);
    }

    public addAction(
        _icon: string,
        _title: string,
        _callback: (evt: MouseEvent) => unknown
    ): HTMLElement {
        return attachDomHelpers(document.createElement("button"));
    }

    public abstract getDisplayText(): string;

    public getIcon(): string {
        return "document";
    }

    public abstract getViewType(): string;

    public async onClose(): Promise<void> {
        await Promise.resolve();
    }

    public async onOpen(): Promise<void> {
        await Promise.resolve();
    }
}

export class Notice {
    public duration: number;
    public message: string;

    public constructor(message: string, duration: number = 4000) {
        this.message = message;
        this.duration = duration;
    }
}

export class Plugin {
    public app: unknown;
    public manifest: unknown;

    public constructor(app: unknown, manifest: unknown) {
        this.app = app;
        this.manifest = manifest;
    }

    public addCommand(command: unknown): unknown {
        return command;
    }

    public addRibbonIcon(
        _icon: string,
        _title: string,
        _callback: (evt: MouseEvent) => unknown
    ): HTMLElement {
        return document.createElement("div");
    }

    public addSettingTab(_settingTab: unknown): void {
        // Mock implementation.
    }

    public addStatusBarItem(): HTMLElement {
        const el: HTMLElement = document.createElement("div");
        el.setText = (val: string): void => {
            el.textContent = val;
        };
        return el;
    }

    public async loadData(): Promise<unknown> {
        return {};
    }

    public registerDomEvent(
        el: HTMLElement,
        type: string,
        callback: (evt: Event) => unknown
    ): void {
        el.addEventListener(type, callback);
    }

    public registerInterval(id: number): number {
        return id;
    }

    public registerView(
        _type: string,
        _viewCreator: (leaf: WorkspaceLeaf) => unknown
    ): void {
        // Mock implementation.
    }

    public async saveData(_data: unknown): Promise<void> {
        // Mock implementation.
    }
}

export interface MockButtonComponent {
    buttonEl: HTMLButtonElement;
    cta: boolean;
    disabled: boolean;
    onClick: (handler: () => unknown) => MockButtonComponent;
    setButtonText: (text: string) => MockButtonComponent;
    setCta: () => MockButtonComponent;
    setDisabled: (disabled: boolean) => MockButtonComponent;
}

export interface MockDropdownComponent {
    addOption: (value: string, display: string) => MockDropdownComponent;
    onChange: (handler: (value: string) => unknown) => MockDropdownComponent;
    options: Map<string, string>;
    selectEl: HTMLSelectElement;
    setValue: (value: string) => MockDropdownComponent;
}

export interface MockTextComponent {
    inputEl: HTMLInputElement;
    onChange: (handler: (value: string) => unknown) => MockTextComponent;
    setPlaceholder: (placeholder: string) => MockTextComponent;
    setValue: (value: string) => MockTextComponent;
}

export class PluginSettingTab {
    public app: unknown;
    public containerEl: HTMLElement;
    public plugin: unknown;

    public constructor(app: unknown, plugin: unknown) {
        this.app = app;
        this.plugin = plugin;
        const el: HTMLElement = document.createElement("div");
        el.empty = (): void => {
            el.replaceChildren();
        };
        this.containerEl = el;
    }

    public display(): void {
        // Mock implementation.
    }

    public getControlValue(_key: string): unknown {
        return undefined;
    }

    public getSettingDefinitions(): unknown[] {
        return [];
    }

    public hide(): void {
        // Mock implementation.
    }

    public setControlValue(_key: string, _value: unknown): void | Promise<void> {
        // Mock implementation.
    }
}

const SECRET_ID_REGEX: RegExp = /^[a-z0-9-]{1,64}$/;

export class SecretComponent extends BaseComponent {
    public static instances: SecretComponent[] = [];

    public app: unknown;
    public containerEl: HTMLElement;
    public onChangeHandler: ((value: string | null) => unknown) | null = null;
    public value: string = "";

    public constructor(app: unknown, containerEl: HTMLElement) {
        super();
        this.app = app;
        this.containerEl = containerEl;
        const inputEl: HTMLInputElement = document.createElement("input");
        inputEl.type = "text";
        inputEl.classList.add("secret-component");
        this.containerEl.appendChild(inputEl);
        SecretComponent.instances.push(this);
    }

    public onChange(cb: (value: string | null) => unknown): this {
        this.onChangeHandler = cb;
        return this;
    }

    public setValue(value: string): this {
        this.value = value;
        return this;
    }
}

export class SecretStorage {
    private readonly secrets: Map<string, string> = new Map<string, string>();

    public getSecret(id: string): string | null {
        const stored: string | undefined = this.secrets.get(id);
        return stored !== undefined ? stored : null;
    }

    public listSecrets(): string[] {
        return Array.from(this.secrets.keys());
    }

    public setSecret(id: string, secret: string): void {
        if (!SECRET_ID_REGEX.test(id)) {
            throw new Error(
                "Invalid secret ID. Please only use lowercase alphanumeric characters and hyphens, up to 64 characters."
            );
        }
        this.secrets.set(id, secret);
    }
}

export class Setting {
    public static instances: Setting[] = [];

    public buttonComponent: MockButtonComponent | null = null;
    public buttonOnClick: (() => unknown) | null = null;
    public controlEl: HTMLElement;
    public desc: string = "";
    public descEl: HTMLElement;
    public dropdownComponent: MockDropdownComponent | null = null;
    public dropdownOnChange: ((value: string) => unknown) | null = null;
    public isHeading: boolean = false;
    public name: string = "";
    public nameEl: HTMLElement;
    public secretComponent: SecretComponent | null = null;
    public settingEl: HTMLElement;
    public textComponent: MockTextComponent | null = null;
    public textOnChange: ((value: string) => unknown) | null = null;

    public constructor(containerEl: HTMLElement) {
        this.settingEl = attachDomHelpers(document.createElement("div"));
        this.nameEl = attachDomHelpers(document.createElement("div"));
        this.descEl = attachDomHelpers(document.createElement("div"));
        this.controlEl = attachDomHelpers(document.createElement("div"));
        this.settingEl.appendChild(this.nameEl);
        this.settingEl.appendChild(this.descEl);
        this.settingEl.appendChild(this.controlEl);
        containerEl.appendChild(this.settingEl);
        Setting.instances.push(this);
    }

    public addButton(cb: (button: MockButtonComponent) => unknown): this {
        const buttonEl: HTMLButtonElement = document.createElement("button");
        this.controlEl.appendChild(buttonEl);
        const buttonObj: MockButtonComponent = {
            buttonEl,
            cta: false,
            disabled: false,
            onClick: (handler: () => unknown): MockButtonComponent => {
                this.buttonOnClick = handler;
                return buttonObj;
            },
            setButtonText: (text: string): MockButtonComponent => {
                buttonEl.textContent = text;
                return buttonObj;
            },
            setCta: (): MockButtonComponent => {
                buttonObj.cta = true;
                buttonEl.classList.add("mod-cta");
                return buttonObj;
            },
            setDisabled: (disabled: boolean): MockButtonComponent => {
                buttonObj.disabled = disabled;
                buttonEl.disabled = disabled;
                return buttonObj;
            }
        };
        this.buttonComponent = buttonObj;
        cb(buttonObj);
        return this;
    }

    public addComponent<T extends BaseComponent>(
        cb: (el: HTMLElement) => T
    ): this {
        const component: T = cb(this.controlEl);
        if (component instanceof SecretComponent) {
            this.secretComponent = component;
        }
        return this;
    }

    public addDropdown(cb: (dropdown: MockDropdownComponent) => unknown): this {
        const selectEl: HTMLSelectElement = document.createElement("select");
        this.controlEl.appendChild(selectEl);
        const options: Map<string, string> = new Map<string, string>();
        const dropdownObj: MockDropdownComponent = {
            addOption: (value: string, display: string): MockDropdownComponent => {
                options.set(value, display);
                const opt: HTMLOptionElement = document.createElement("option");
                opt.value = value;
                opt.textContent = display;
                selectEl.appendChild(opt);
                return dropdownObj;
            },
            onChange: (handler: (value: string) => unknown): MockDropdownComponent => {
                this.dropdownOnChange = handler;
                return dropdownObj;
            },
            options,
            selectEl,
            setValue: (value: string): MockDropdownComponent => {
                selectEl.value = value;
                return dropdownObj;
            }
        };
        this.dropdownComponent = dropdownObj;
        cb(dropdownObj);
        return this;
    }

    public addText(cb: (text: MockTextComponent) => unknown): this {
        const inputEl: HTMLInputElement = document.createElement("input");
        inputEl.type = "text";
        this.controlEl.appendChild(inputEl);
        const textObj: MockTextComponent = {
            inputEl,
            onChange: (handler: (value: string) => unknown): MockTextComponent => {
                this.textOnChange = handler;
                return textObj;
            },
            setPlaceholder: (placeholder: string): MockTextComponent => {
                inputEl.placeholder = placeholder;
                return textObj;
            },
            setValue: (value: string): MockTextComponent => {
                inputEl.value = value;
                return textObj;
            }
        };
        this.textComponent = textObj;
        cb(textObj);
        return this;
    }

    public addToggle(cb: (toggle: unknown) => unknown): this {
        const toggleObj = {
            onChange: (_handler: (value: boolean) => unknown) => toggleObj,
            setValue: (_value: boolean) => toggleObj
        };
        cb(toggleObj);
        return this;
    }

    public setDesc(desc: string): this {
        this.desc = desc;
        this.descEl.textContent = desc;
        return this;
    }

    public setHeading(): this {
        this.isHeading = true;
        return this;
    }

    public setName(name: string): this {
        this.name = name;
        this.nameEl.textContent = name;
        return this;
    }
}

export class SettingGroup {
    public static instances: SettingGroup[] = [];

    public groupEl: HTMLElement;
    public heading: string = "";
    public listEl: HTMLElement;
    public settings: Setting[] = [];

    public constructor(containerEl: HTMLElement) {
        this.groupEl = document.createElement("div");
        this.groupEl.classList.add("setting-group");
        this.listEl = document.createElement("div");
        this.listEl.classList.add("setting-items");
        this.groupEl.appendChild(this.listEl);
        containerEl.appendChild(this.groupEl);
        SettingGroup.instances.push(this);
    }

    public addClass(...classes: string[]): this {
        this.groupEl.classList.add(...classes);
        return this;
    }

    public addSetting(cb: (setting: Setting) => void): this {
        const setting: Setting = new Setting(this.listEl);
        this.settings.push(setting);
        cb(setting);
        return this;
    }

    public setHeading(text: string | DocumentFragment): this {
        this.heading =
            typeof text === "string" ? text : (text.textContent ?? "");
        return this;
    }
}

export class TAbstractFile {
    public name: string = "";
    public path: string = "";
}

export class TFile extends TAbstractFile {
    public basename: string = "";
    public extension: string = "";
    public stat: { ctime: number; mtime: number; size: number } = {
        ctime: 0,
        mtime: 0,
        size: 0
    };
}

export class TFolder extends TAbstractFile {
    public children: TAbstractFile[] = [];

    public isRoot(): boolean {
        return this.path === "" || this.path === "/";
    }
}

export function normalizePath(path: string): string {
    const replaced: string = path.replace(/\\/g, "/").replace(/\/+/g, "/");
    const trimmed: string = replaced.replace(/^\/+/, "").replace(/\/+$/, "");
    return trimmed === "" ? "/" : trimmed;
}

export function requireApiVersion(_version: string): boolean {
    return true;
}

export function requestUrl(_request: RequestUrlParam | string): RequestUrlResponsePromise {
    const rejected: Promise<RequestUrlResponse> = Promise.reject(
        new Error("requestUrl must be mocked in unit tests")
    );
    return Object.assign(rejected, {
        arrayBuffer: Promise.reject(new Error("requestUrl must be mocked in unit tests")),
        json: Promise.reject(new Error("requestUrl must be mocked in unit tests")),
        text: Promise.reject(new Error("requestUrl must be mocked in unit tests"))
    });
}
