import type { RequestUrlParam, RequestUrlResponse, RequestUrlResponsePromise } from "obsidian";

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

    public registerInterval(id: number): number {
        return id;
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

    public hide(): void {
        // Mock implementation.
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
    public settingEl: HTMLElement;
    public textComponent: MockTextComponent | null = null;
    public textOnChange: ((value: string) => unknown) | null = null;

    public constructor(containerEl: HTMLElement) {
        this.settingEl = document.createElement("div");
        this.nameEl = document.createElement("div");
        this.descEl = document.createElement("div");
        this.controlEl = document.createElement("div");
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
