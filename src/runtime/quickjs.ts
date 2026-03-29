"use strict";

import { QuickJSContext, QuickJSHandle, QuickJSSyncVariant, QuickJSWASMModule, memoizePromiseFactory, newQuickJSWASMModuleFromVariant, newVariant, shouldInterruptAfterDeadline } from "quickjs-emscripten-core";

export const QUICKJS_WASM_ASSET_NAME = "quickjs-ng.wasm";

const MACRO_TIMEOUT_MS = 1_000;
const POST_COMPILE_HOOK_TIMEOUT_MS = 2_000;
const MAX_RUNTIME_MEMORY_BYTES = 64 * 1024 * 1024;
const MAX_RUNTIME_STACK_BYTES = 512 * 1024;

type ScriptExecutionKind = "macro" | "postCompileHook";

type ScriptExecutionOptions = {
    filename?: string;
    kind?: ScriptExecutionKind;
    lineOffset?: number;
};

let quickJSModule: QuickJSWASMModule | null = null;
const scriptCache: Record<string, string> = {};

function loadQuickJSFFI(): ReturnType<QuickJSSyncVariant["importFFI"]> {
    return Promise.resolve()
        .then(() => require("@jitl/quickjs-ng-wasmfile-release-sync/ffi") as typeof import("@jitl/quickjs-ng-wasmfile-release-sync/ffi"))
        .then((mod) => mod.QuickJSFFI);
}

function unwrapDefaultExport<T>(mod: T | { default: T }): T {
    if (typeof mod === "object" && mod !== null && "default" in mod) {
        return mod.default;
    }
    return mod;
}

function loadQuickJSModuleLoader(): ReturnType<QuickJSSyncVariant["importModuleLoader"]> {
    return Promise.resolve()
        .then(
            () =>
                require("@jitl/quickjs-ng-wasmfile-release-sync/emscripten-module") as
                    | typeof import("@jitl/quickjs-ng-wasmfile-release-sync/emscripten-module")
                    | { default: typeof import("@jitl/quickjs-ng-wasmfile-release-sync/emscripten-module").default },
        )
        .then((mod) => unwrapDefaultExport(mod));
}

const quickJSVariant: QuickJSSyncVariant = {
    type: "sync",
    importFFI: loadQuickJSFFI,
    importModuleLoader: loadQuickJSModuleLoader,
};

function isNodeRuntime(): boolean {
    return typeof process !== "undefined" && typeof process.versions?.node === "string";
}

function getQuickJSWasmLocation(): string {
    if (isNodeRuntime()) {
        const path = require("path") as typeof import("path");
        return path.join(__dirname, QUICKJS_WASM_ASSET_NAME);
    }

    const browserLocation = globalThis as typeof globalThis & { location?: { href?: string } };
    if (typeof browserLocation.location?.href === "string") {
        return new URL(`./${QUICKJS_WASM_ASSET_NAME}`, browserLocation.location.href).toString();
    }

    return QUICKJS_WASM_ASSET_NAME;
}

const loadQuickJSModule: () => Promise<QuickJSWASMModule> = memoizePromiseFactory(async (): Promise<QuickJSWASMModule> => {
    quickJSModule = await newQuickJSWASMModuleFromVariant(newVariant(quickJSVariant, {
        wasmLocation: getQuickJSWasmLocation(),
    }));
    return quickJSModule;
});

export async function initializeQuickJSRuntime(): Promise<void> {
    await loadQuickJSModule();
}

function getQuickJSModule(): QuickJSWASMModule {
    if (!quickJSModule) {
        throw new Error("QuickJS runtime used before initialization");
    }
    return quickJSModule;
}

function createConsoleLog(context: QuickJSContext): QuickJSHandle {
    return context.newFunction("log", (...args: QuickJSHandle[]) => {
        const renderedArgs = args.map((arg) => {
            try {
                return String(context.dump(arg));
            } catch (_error) {
                return "[unserializable]";
            }
        });
        console.log(renderedArgs.join(" "));
    });
}

function installConsole(context: QuickJSContext): void {
    const consoleObject = context.newObject();
    const logFn = createConsoleLog(context);

    context.setProp(consoleObject, "log", logFn);
    context.setProp(context.global, "console", consoleObject);

    logFn.dispose();
    consoleObject.dispose();
}

function normalizeScriptError(error: unknown, filename: string | undefined, lineOffset: number): Error {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    if (!normalizedError.stack || !filename || lineOffset === 0) {
        return normalizedError;
    }

    const escapedFilename = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    normalizedError.stack = normalizedError.stack.replace(
        new RegExp(`(${escapedFilename}:)(\\d+)(:\\d+)`, "g"),
        (_match, prefix: string, line: string, suffix: string) => `${prefix}${Math.max(1, Number(line) - lineOffset)}${suffix}`,
    );
    return normalizedError;
}

function getTimeoutMs(kind: ScriptExecutionKind): number {
    return kind === "postCompileHook" ? POST_COMPILE_HOOK_TIMEOUT_MS : MACRO_TIMEOUT_MS;
}

export function executeQuickJSScript(script: string, options: ScriptExecutionOptions = {}): string {
    if (script in scriptCache) {
        return scriptCache[script];
    }

    const quickJS = getQuickJSModule();
    const runtime = quickJS.newRuntime();
    runtime.setMemoryLimit(MAX_RUNTIME_MEMORY_BYTES);
    runtime.setMaxStackSize(MAX_RUNTIME_STACK_BYTES);
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + getTimeoutMs(options.kind ?? "macro")));

    const context = runtime.newContext();
    installConsole(context);

    try {
        const resultHandle = context.unwrapResult(context.evalCode(script, options.filename));
        const resultType = context.typeof(resultHandle);
        if (resultType !== "string") {
            resultHandle.dispose();
            throw new Error(`JavaScript macro returned value with type of ${resultType}, expected string. Try using .toString()`);
        }

        const scriptResult = context.getString(resultHandle);
        resultHandle.dispose();
        scriptCache[script] = scriptResult;
        return scriptResult;
    } catch (error) {
        throw normalizeScriptError(error, options.filename, options.lineOffset ?? 0);
    } finally {
        context.dispose();
        runtime.dispose();
    }
}
