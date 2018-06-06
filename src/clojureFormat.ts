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

const replEvaluate = async (command: string): Promise<any[]> => {
    return await nreplClient.evaluate(command);
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
        await replEvaluate(`(require 'cljfmt.core) (cljfmt.core/reformat-string "${contents}" ${cljfmtParams})`)
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

const checkEastwood = async (diagnosticsCollection: vscode.DiagnosticCollection, contents: string): Promise<void> => {
    const namespace = getNamespace(contents);
    const result = await replEvaluate(
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
    const addDiagnostic = (file: string, line: number, column: number, msg: string, severity: vscode.DiagnosticSeverity) => {
        const range = new vscode.Range(line-1, column-1, line-1, column);
        let diagnostics = diagnosticMap.get(file);
        if (!diagnostics) { diagnostics = []; }
        diagnostics.push(new vscode.Diagnostic(range, msg, severity));
        diagnosticMap.set(file, diagnostics);
    }

    result.forEach(r => {
        if (!r.value || r.value === 'nil') {
            return;
        }

        const parsedValue = JSON.parse(JSON.parse(r.value));
        parsedValue.warnings.forEach((warning: any) => {
            const path = warning.uri.split('file:/')[1];
            const canonicalFile = vscode.Uri.file(path).toString();
            addDiagnostic(
                canonicalFile,
                warning.line,
                warning.column,
                warning.msg,
                vscode.DiagnosticSeverity.Error
            );
        });


        if (parsedValue.err) {
            addDiagnostic(
                '.',
                1,
                1,
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
    return select.isEmpty ? textEditor.document.getText() : textEditor.document.getText(select);
}

const formatAll = async (textEditor: vscode.TextEditor, selection: vscode.Selection): Promise<string> => {
    let contents: string = getContents(textEditor, selection);

    // Escaping the string before sending it to nREPL
    contents = slashEscape(contents);
    contents = await formatCljfmt(contents);

    return contents;
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
            reject(error);
            return;
        }

        const selection = getTextEditorSelection(textEditor);
        formatAll(textEditor, selection).then(new_content => {
            textEditor.edit(editBuilder => {
                editBuilder.replace(selection, new_content);
                resolve();
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
            e.waitUntil(formatFile(textEditor, undefined));
        }
    });
}
