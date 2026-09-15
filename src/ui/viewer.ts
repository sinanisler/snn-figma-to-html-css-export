import { defaultKeymap } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState } from '@codemirror/state';
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';

export type ViewerLang = 'html' | 'css' | 'jsx' | 'vue' | 'svelte' | 'json' | 'js';

export type Viewer = { show(text: string, lang: ViewerLang): void; setWrap(on: boolean): void };

const languageFor = (lang: ViewerLang) =>
	lang === 'css' ? css() : lang === 'jsx' || lang === 'js' ? javascript({ jsx: true }) : lang === 'json' ? javascript() : html();

const theme = EditorView.theme({
	'&': {
		height: '100%',
		fontSize: '12px',
		backgroundColor: 'var(--figma-color-bg)',
		color: 'var(--figma-color-text)',
	},
	'.cm-scroller': {
		fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
		lineHeight: '1.55',
	},
	'.cm-gutters': {
		backgroundColor: 'var(--figma-color-bg-secondary)',
		color: 'var(--figma-color-text-tertiary)',
		border: 'none',
	},
	'.cm-activeLine': { backgroundColor: 'var(--figma-color-bg-hover)' },
	'.cm-activeLineGutter': { backgroundColor: 'transparent' },
	'&.cm-focused': { outline: 'none' },
	'&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
		backgroundColor: 'var(--figma-color-bg-selected) !important',
	},
	'.cm-cursor': { borderLeftColor: 'var(--figma-color-text)' },
	'.cm-panels': { backgroundColor: 'var(--figma-color-bg-secondary)', color: 'var(--figma-color-text)' },
});

const isDark = () => document.documentElement.classList.contains('figma-dark');
const highlightFor = () => syntaxHighlighting(isDark() ? oneDarkHighlightStyle : defaultHighlightStyle);

export function createViewer(parent: HTMLElement): Viewer {
	const language = new Compartment();
	const highlight = new Compartment();
	const wrapping = new Compartment();
	const view = new EditorView({
		parent,
		state: EditorState.create({
			doc: '',
			extensions: [
				lineNumbers(),
				foldGutter(),
				drawSelection(),
				highlightActiveLine(),
				bracketMatching(),
				highlightSelectionMatches(),
				EditorState.readOnly.of(true),
				keymap.of([...defaultKeymap, ...searchKeymap, ...foldKeymap]),
				theme,
				language.of(html()),
				highlight.of(highlightFor()),
				wrapping.of([]),
			],
		}),
	});

	new MutationObserver(() => view.dispatch({ effects: highlight.reconfigure(highlightFor()) })).observe(
		document.documentElement,
		{ attributes: true, attributeFilter: ['class'] },
	);

	return {
		show(text, lang) {
			view.dispatch({
				changes: { from: 0, to: view.state.doc.length, insert: text },
				effects: [language.reconfigure(languageFor(lang)), EditorView.scrollIntoView(0)],
				selection: { anchor: 0 },
			});
		},
		setWrap(on) {
			view.dispatch({ effects: wrapping.reconfigure(on ? EditorView.lineWrapping : []) });
		},
	};
}
