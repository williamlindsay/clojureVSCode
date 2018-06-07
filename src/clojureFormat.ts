import * as vscode from 'vscode';

import { cljConnection } from './cljConnection';
import { cljParser } from './cljParser';
import { nreplClient } from './nreplClient';

function slashEscape(contents: string) {
    return contents
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n');
}

function slashUnescape(contents: string) {
    const replacements : { [key: string]: string} = { '\\\\': '\\', '\\n': '\n', '\\"': '"' };
    return contents.replace(/\\(\\|n|")/g, function(match) {
        return replacements[match]
    });
}

const parseCljfmtOutput = (value: any[]): string => {
    if ('ex' in value[0]) {
        vscode.window.showErrorMessage(value[1].err);
        throw value[1].err;
    };
    if (('value' in value[1]) && (value[1].value != 'nil')) {
        let new_content: string = value[1].value.slice(1, -1);
        new_content = slashUnescape(new_content);
        return new_content;
    };

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
    return parseCljfmtOutput(
        await nreplClient.evaluate(`(require 'cljfmt.core) (cljfmt.core/reformat-string "${contents}" ${cljfmtParams})`)
    );
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

const getNamespace = (contents: string): string => {
    return contents.split('(ns ', 2)[1].split(' ', 1)[0].trim();
}

const addDiagnostic = (
    diagnosticMap: Map<string, vscode.Diagnostic[]>,
    file: string,
    line: { start: number, end: number },
    column: { start: number, end: number },
    msg: string,
    severity: vscode.DiagnosticSeverity
) => {
    const range = new vscode.Range(line.start, column.start, line.end, column.end);
    let diagnostics = diagnosticMap.get(file);
    if (!diagnostics) { diagnostics = []; }
    diagnostics.push(new vscode.Diagnostic(range, msg, severity));
    diagnosticMap.set(file, diagnostics);
}

const bikeshedCommand = (filename: string) => `
    (require \'[bikeshed.core :as b])
    (let [all-files [(clojure.java.io/file "${filename}")]]
      (b/long-lines all-files :max-line-length 90)
      (b/trailing-whitespace all-files)
      (b/trailing-blank-lines all-files)
      (b/bad-roots all-files))
`;

const checkBikeshed = async (diagnosticsCollection: vscode.DiagnosticCollection, filename: string): Promise<void> => {
    const result = await nreplClient.evaluate(bikeshedCommand(filename.replace(/\\/g, '\\\\')));
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
            { start: 0, end: line.length - 1 },
            `${rule}: ${line}`,
            vscode.DiagnosticSeverity.Error
        )
    });

    diagnosticMap.forEach((diags, file) => {
        diagnosticsCollection.set(vscode.Uri.parse(file), diags);
    });
}

const checkEastwood = async (diagnosticsCollection: vscode.DiagnosticCollection, contents: string): Promise<void> => {
    const namespace = getNamespace(contents);
    const result = await nreplClient.evaluate(
        `(require \'[eastwood.lint :as e]
                  \'[clojure.data.json :as json])
         (json/write-str
           (e/lint {:namespaces [(symbol "${namespace}")]
                    :config-files ["eastwood.clj"]
                    :exclude-linters [:suspicious-expression]
                    :add-linters [:unused-namespaces]})
           :value-fn
           (fn [key value] (if (instance? java.net.URI value) (.toString value) value)))`
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
    diagnosticMap.forEach((diags, file) => {
        diagnosticsCollection.set(vscode.Uri.parse(file), diags);
    });
}

const getContents = (textEditor: vscode.TextEditor, selection?: vscode.Selection): string => {
    const select = selection ? selection : getTextEditorSelection(textEditor);
    const contents =  select.isEmpty ? textEditor.document.getText() : textEditor.document.getText(select);
    return slashEscape(contents);
}

const getTextEditorSelection = (textEditor: vscode.TextEditor): vscode.Selection => {
    let selection = textEditor.selection;
    if (textEditor.selection.isEmpty) {
        const lines: string[] = textEditor.document.getText().split(/\r?\n/g);
        const lastChar: number = lines[lines.length - 1].length;
        selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(textEditor.document.lineCount, lastChar));
    }

    return selection;
}

export const formatFile = (textEditor: vscode.TextEditor, edit?: vscode.TextEditorEdit): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
        if (!cljConnection.isConnected()) {
            const error = "Formatting functions don't work, connect to nREPL first.";
            vscode.window.showErrorMessage(error);
            return reject(error);
        }

        const selection = getTextEditorSelection(textEditor);
        const contents = getContents(textEditor, selection);
        formatCljfmt(contents).then(new_contents => {
            textEditor.edit(editBuilder => {
                editBuilder.replace(selection, new_contents);
                return resolve();
            });
        }, reject);
    });
}

export const maybeActivateFormatOnSave = (diagnosticsCollection: vscode.DiagnosticCollection) => {
    vscode.workspace.onWillSaveTextDocument(e => {
        const document = e.document;
        if (document.languageId !== "clojure") {
            return;
        }
        const textEditor = vscode.window.activeTextEditor;
        if (!textEditor) {
            return
        }
        diagnosticsCollection.clear();

        const editorConfig = vscode.workspace.getConfiguration('editor');
        const globalEditorFormatOnSave = editorConfig && editorConfig.has('formatOnSave') && editorConfig.get('formatOnSave') === true;
        const clojureConfig = vscode.workspace.getConfiguration('clojureVSCode');
        if ((clojureConfig.formatOnSave || globalEditorFormatOnSave) && textEditor.document === document) {
            checkEastwood(diagnosticsCollection, getContents(textEditor));
            checkBikeshed(diagnosticsCollection, document.fileName);
            e.waitUntil(formatFile(textEditor, undefined));
        }
    });
}
