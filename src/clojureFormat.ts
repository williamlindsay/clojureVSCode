import * as vscode from 'vscode';

import { cljConnection } from './cljConnection';
import { nreplClient } from './nreplClient';
import { cljParser } from './cljParser';

function slashEscape(contents: string) {
    return contents
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"');
}

function slashUnescape(contents: string) {
    const replacements : { [key: string]: string} = { '\\\\': '\\', '\\n': '\n', '\\"': '"' };
    return contents.replace(/\\(\\|n|")/g, function(match) {
        return replacements[match]
    });
}

const parseCljfmtOutput = (value: any[]): string => {
    for (const v of value) {
        if (v.value && v.value !== 'nil') {
            let new_content: string = v.value.slice(1, -1);
            new_content = slashUnescape(new_content);
            return new_content;
        } else if (v.err) {
            throw v.err;
        } else if (v.ex) {
            throw v.ex;
        }
    }

    throw 'Unknown error';
}

const formatCljfmt = async (contents: string): Promise<string> => {
    let cljfmtParams = vscode.workspace.getConfiguration('clojureVSCode').cljfmtParameters;
    cljfmtParams = cljfmtParams.isEmpty ? "nil" : "{"+cljfmtParams+"}";

    // Running "(require 'cljfmt.core)" in right after we have checked we are connected to nREPL
    // would be a better option but in this case "cljfmt.core/reformat-string" fails the first
    // time it is called. I have no idea what causes this behavior so I decided to put the require
    // statement right here - don't think it does any harm. If someone knows how to fix it
    // please send a pull request with a fix.
    const result = await nreplClient.evaluate(`(require 'cljfmt.core) (cljfmt.core/reformat-string "${contents}" ${cljfmtParams})`);
    return parseCljfmtOutput(result);
}

interface IProblem {
    msg: string;
    uri: string;
    column: number;
    line: number;
}

interface IEastwoodReport {
    warnings: IProblem[];
    err?: any;
    'err-data'?: any;
}

const isNumberValid = (n: number) => n !== undefined && n !== null && !isNaN(n);

const addDiagnostic = (
    diagnosticMap: Map<string, vscode.Diagnostic[]>,
    file: string,
    line: { start: number, end: number },
    column: { start: number, end: number },
    msg: string,
    severity: vscode.DiagnosticSeverity
) => {
    const range = new vscode.Range(
        isNumberValid(line.start) ? line.start : 0,
        isNumberValid(column.start) ? column.start : 0,
        isNumberValid(line.end) ? line.end : 0,
        isNumberValid(column.end) ? column.end : 0
    );
    let diagnostics = diagnosticMap.get(file);
    if (!diagnostics) { diagnostics = []; }
    diagnostics.push(new vscode.Diagnostic(range, msg, severity));
    diagnosticMap.set(file, diagnostics);
}

const bikeshedCommand = (filename: string) => `
    (require \'[bikeshed.core :as b]
             \'[leiningen.core.project :as p])
    (let [options (:bikeshed (p/read))
          all-files [(clojure.java.io/file "${filename}")]]
      (if-not (false? (:long-lines options))
        (b/long-lines
          all-files
          :max-line-length
          (or (:max-line-length options) 80)))
      (if-not (false? (:trailing-whitespace options))
        (b/trailing-whitespace all-files))
      (if-not (false? (:trailing-blank-lines options))
        (b/trailing-blank-lines all-files))
      (if-not (false? (:var-redefs options))
        (b/bad-roots all-files)))
`;

const checkBikeshed = async (filename: string): Promise<Map<string, vscode.Diagnostic[]>> => {
    const file = filename.replace(/\\/g, '\\\\');
    const result = await nreplClient.evaluate(bikeshedCommand(file));
    const diagnosticMap: Map<string, vscode.Diagnostic[]> = new Map();

    let rule: string | null;
    result.forEach(r => {
        if (!r.out) {
            rule = null;
            return;
        }

        const out: string = r.out.trim();
        if (out.startsWith('Checking for')) {
            const i = out.indexOf('.');
            rule = r.out.substring('Checking for'.length + 2, i);
            return;
        }

        if (out.startsWith('No ')) {
            rule = null;
            return;
        }

        const extIndex = out.indexOf('.clj');
        const file = out.substring(0, extIndex + 4);
        const rest = out.substring(extIndex + 5, out.length);

        const colonIndex = rest.indexOf(':');
        const lineNumber = +rest.substring(0, colonIndex) - 1;
        const line = rest.substring(colonIndex + 1, rest.length);

        addDiagnostic(
            diagnosticMap,
            vscode.Uri.file(file).toString(),
            { start: lineNumber, end: lineNumber },
            { start: 0, end: line.length },
            `${rule}: ${line}`,
            vscode.DiagnosticSeverity.Error
        )
    });

    return diagnosticMap;
}

const checkEastwood = async (namespace: string): Promise<Map<string, vscode.Diagnostic[]>> => {
    const result = await nreplClient.evaluate(
        `(require \'[eastwood.lint :as e]
                  \'[leiningen.core.project :as p]
                  \'[clojure.data.json :as json]
                  \'[${namespace}])
         (json/write-str
           (e/lint (assoc (:eastwood (p/read)) :namespaces [(symbol "${namespace}")]))
           :value-fn
           (fn [key value] (cond
                             (instance? java.net.URI value) (.toString value)
                             (var? value) (.toString value)
                             :else value)))`
    );
    const diagnosticMap: Map<string, vscode.Diagnostic[]> = new Map();
    result.forEach(r => {
        if (!r.value || r.value === 'nil') {
            return;
        }

        const parsedValue = JSON.parse(JSON.parse(r.value));
        parsedValue.warnings.forEach((warning: any) => {
            const path = warning.uri.split('file:/')[1];
            const canonicalFile = vscode.Uri.file(path).toString();
            addDiagnostic(
                diagnosticMap,
                canonicalFile,
                { start: warning.line - 1, end: warning.line - 1 },
                { start: warning.column - 1, end: warning.column },
                warning.msg,
                vscode.DiagnosticSeverity.Error
            );
        });


        if (parsedValue.err) {
            addDiagnostic(
                diagnosticMap,
                '.',
                { start: 0, end: 0 },
                { start: 0, end: 1 },
                `ERROR: ${parsedValue.err} - ${JSON.stringify(parsedValue['err-data'])}`,
                vscode.DiagnosticSeverity.Error
            );
        }
    });

    return diagnosticMap;
}

const checkBuild = async (contents: string, filename: string): Promise<Map<string, vscode.Diagnostic[]>> => {
    const file = filename.replace(/\\/g, '/');
    const result = await nreplClient.evaluate(`
        (load-file "${file}")
    `);
    const diagnosticMap: Map<string, vscode.Diagnostic[]> = new Map();
    result.forEach(r => {
        if (!r.err) {
            return;
        }

        let error: string = r.err.trim();
        const columnIndex = error.lastIndexOf(':');
        const column = +error.slice(columnIndex + 1).replace(')', '');

        error = error.slice(0, columnIndex);
        const lineIndex = error.lastIndexOf(':');
        const endLine = +error.slice(lineIndex + 1);

        error = error.slice(0, lineIndex);
        const canonicalFile = vscode.Uri.file(file).toString();

        const startStr = 'starting at line ';
        const startIndex = error.indexOf(startStr);
        let startLine = endLine;
        if (startIndex !== -1) {
            const i = startIndex + startStr.length;
            startLine = +error.substring(i, error.indexOf(',', i))
        }

        addDiagnostic(
            diagnosticMap,
            canonicalFile,
            { start: startLine - 1, end: endLine },
            { start: column - 1, end: column },
            error,
            error.startsWith('WARNING:') ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error
        );
    })

    return diagnosticMap;
}

const getContents = (document: vscode.TextDocument): string => {
    const contents =  document.getText();
    return slashEscape(contents);
}

const getTextEditorSelection = (textEditor: vscode.TextEditor): vscode.Selection => {
    const lines: string[] = textEditor.document.getText().split(/\r?\n/g);
    const lastChar: number = lines[lines.length - 1].length;
    return new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(textEditor.document.lineCount, lastChar));
}

const performLintChecks = async (
    diagnosticsCollection: vscode.DiagnosticCollection,
    document: vscode.TextDocument
): Promise<void> => {
    const filename = document.fileName;
    const contents = getContents(document);
    const namespace = cljParser.getNamespace(contents);
    const maps = [
        await checkBuild(contents, filename),
        await checkEastwood(namespace),
        await checkBikeshed(filename)
    ];

    const diagnosticMap: Map<string, vscode.Diagnostic[]> = new Map();
    maps.forEach(m => {
        m.forEach((v, k) => {
            let diagnostics = diagnosticMap.get(k);
            if (!diagnostics) { diagnostics = []; }
            diagnostics.push(...v);
            diagnosticMap.set(k, diagnostics);
        });
    });

    diagnosticMap.forEach((diags, file) => {
        diagnosticsCollection.set(vscode.Uri.parse(file), diags);
    });
}

export const format = (textEditor: vscode.TextEditor): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
        if (!cljConnection.isConnected()) {
            return reject("Formatting functions don't work, connect to nREPL first.");
        }

        const selection = getTextEditorSelection(textEditor);
        const contents = getContents(textEditor.document);
        formatCljfmt(contents).then(new_contents => {
            textEditor.edit(editBuilder => {
                editBuilder.replace(selection, new_contents);
                return resolve();
            });
        }, reject);
    });
}

export const formatFile = async (textEditor: vscode.TextEditor, edit?: vscode.TextEditorEdit): Promise<void> => {
    try {
        await format(textEditor);
    } catch (e) {
        vscode.window.showErrorMessage(e);
    }
}

const shouldRunFormat = (document: vscode.TextDocument) => {
    const editorConfig = vscode.workspace.getConfiguration('editor');
    const globalEditorFormatOnSave = editorConfig && editorConfig.has('formatOnSave') && editorConfig.get('formatOnSave') === true;
    const clojureConfig = vscode.workspace.getConfiguration('clojureVSCode');

    return document.languageId === "clojure" &&
           (clojureConfig.formatOnSave || globalEditorFormatOnSave);
}

export const maybeActivateFormatOnSave = (diagnosticsCollection: vscode.DiagnosticCollection) => {
    vscode.workspace.onWillSaveTextDocument(e => {
        const document = e.document;
        const textEditor = vscode.window.activeTextEditor;
        if (!textEditor) {
            return
        }

        if (shouldRunFormat(document) && textEditor.document === document) {
            e.waitUntil(formatFile(textEditor, undefined));
        }
    });

    vscode.workspace.onDidSaveTextDocument(e => {
        if (shouldRunFormat(e)) {
            diagnosticsCollection.clear();
            vscode.window.withProgress(
                { title: 'Linting...', location: vscode.ProgressLocation.Window },
                () => performLintChecks(diagnosticsCollection, e)
            );
        }
    })
}
