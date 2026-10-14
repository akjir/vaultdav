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

export class PluginSettingTab {
    public app: unknown;
    public containerEl: HTMLElement;
    public plugin: unknown;

    public constructor(app: unknown, plugin: unknown) {
        this.app = app;
        this.plugin = plugin;
        this.containerEl = document.createElement("div");
    }

    public display(): void {
        // Mock implementation.
    }

    public hide(): void {
        // Mock implementation.
    }
}

export class Setting {
    public settingEl: HTMLElement;

    public constructor(containerEl: HTMLElement) {
        this.settingEl = document.createElement("div");
        containerEl.appendChild(this.settingEl);
    }

    public addButton(cb: (button: unknown) => unknown): this {
        const buttonObj = {
            onClick: (_handler: () => unknown) => buttonObj,
            setButtonText: (_text: string) => buttonObj,
            setCta: () => buttonObj
        };
        cb(buttonObj);
        return this;
    }

    public addDropdown(cb: (dropdown: unknown) => unknown): this {
        const dropdownObj = {
            addOption: (_value: string, _display: string) => dropdownObj,
            onChange: (_handler: (value: string) => unknown) => dropdownObj,
            setValue: (_value: string) => dropdownObj
        };
        cb(dropdownObj);
        return this;
    }

    public addText(cb: (text: unknown) => unknown): this {
        const inputEl: HTMLInputElement = document.createElement("input");
        const textObj = {
            inputEl,
            onChange: (_handler: (value: string) => unknown) => textObj,
            setPlaceholder: (_placeholder: string) => textObj,
            setValue: (_value: string) => textObj
        };
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

    public setDesc(_desc: string): this {
        return this;
    }

    public setName(_name: string): this {
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
