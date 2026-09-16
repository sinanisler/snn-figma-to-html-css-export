import { pascalCase } from './format';
import { classList, type IRLink, type IRNode } from './ir';
import type { Binding } from './emit';

export type PropKind = 'text' | 'src' | 'alt' | 'href';

export type ComponentProp = {
	name: string;
	kind: PropKind;
	/** Value in the first instance, used as the prop's default. */
	fallback: string;
};

export type ComponentDef = {
	name: string;
	/** The first instance: every instance renders from this tree. */
	template: IRNode;
	props: ComponentProp[];
	/** Template node → which of its values come from props. */
	bindings: Map<IRNode, Binding>;
};

export type ComponentUse = { def: ComponentDef; props: [string, string][] };

export type ComponentSet = { defs: ComponentDef[]; uses: Map<IRNode, ComponentUse> };

const RESERVED = new Set([
	'class', 'for', 'default', 'new', 'delete', 'function', 'return', 'var', 'let', 'const', 'if', 'else', 'switch',
	'case', 'this', 'import', 'export', 'in', 'of', 'do', 'while', 'with', 'typeof', 'void', 'key', 'ref', 'children',
	'props', 'style', 'slot', 'is',
]);

/** One value slot per node in document order: text of single-run nodes, img src/alt, link href. */
type Slot = { node: IRNode; kind: PropKind; value: string };

function slots(root: IRNode, href: (n: IRNode, link: IRLink) => string): Slot[] {
	const out: Slot[] = [];
	const visit = (n: IRNode) => {
		if (n.runs?.length === 1 && !n.runs[0].href && n.tag !== 'select') out.push({ node: n, kind: 'text', value: n.runs[0].text });
		if (n.tag === 'img' && n.attrs.src !== undefined) {
			out.push({ node: n, kind: 'src', value: n.attrs.src });
			out.push({ node: n, kind: 'alt', value: n.attrs.alt ?? '' });
		}
		if (n.link) out.push({ node: n, kind: 'href', value: href(n, n.link) });
		n.children.forEach(visit);
	};
	visit(root);
	return out;
}

/**
 * Structure only: instances with the same signature can share one component. The root's
 * classes are left out — they carry the instance's placement and are passed as a class prop.
 */
function signature(n: IRNode, root = true): string {
	const attrs = Object.entries(n.attrs)
		.filter(([k]) => k !== 'src' && k !== 'alt')
		.sort(([a], [b]) => a.localeCompare(b));
	const runs = n.runs && (n.runs.length !== 1 || n.runs[0].href) ? n.runs.map((r) => [r.text, r.className, r.href]) : n.runs?.length;
	const look = root ? null : [classList(n), n.style];
	return JSON.stringify([n.tag, look, attrs, runs, !!n.link, n.svgAsset, n.children.map((c) => signature(c, false))]);
}

function isLeaf(n: IRNode): boolean {
	return n.children.length === 0;
}

const propBase = (name: string, fallback: string) => {
	const p = pascalCase(name, '');
	const base = p ? p[0].toLowerCase() + p.slice(1) : fallback;
	return /^[a-z]/i.test(base) ? base : fallback;
};

/**
 * Groups the outermost Figma component instances (by component and structure) into
 * reusable components. Values that differ between instances become props.
 */
export function extractComponents(
	pages: IRNode[][],
	href: (n: IRNode, link: IRLink) => string,
	reservedNames: Iterable<string> = [],
): ComponentSet {
	const groups = new Map<string, IRNode[]>();
	const visit = (n: IRNode) => {
		if (n.componentKey && !isLeaf(n)) {
			const key = `${n.componentKey}|${signature(n)}`;
			groups.set(key, [...(groups.get(key) ?? []), n]);
			return;
		}
		n.children.forEach(visit);
	};
	pages.forEach((roots) => roots.forEach(visit));

	const used = new Set(reservedNames);
	const defs: ComponentDef[] = [];
	const uses = new Map<IRNode, ComponentUse>();
	for (const instances of groups.values()) {
		const [template] = instances;
		let name = pascalCase(template.componentName ?? template.name, 'Component');
		const base = name;
		for (let i = 2; used.has(name); i++) name = `${base}${i}`;
		used.add(name);

		const perInstance = instances.map((i) => slots(i, href));
		const bindings = new Map<IRNode, Binding>();
		const props: ComponentProp[] = [];
		const propNames = new Set<string>();
		perInstance[0].forEach((slot, index) => {
			const values = new Set(perInstance.map((s) => s[index]?.value));
			if (values.size < 2) return;
			const suffix = slot.kind === 'text' ? '' : slot.kind[0].toUpperCase() + slot.kind.slice(1);
			let prop = propBase(slot.node.name, slot.kind === 'text' ? 'text' : slot.kind) + suffix;
			if (slot.kind === 'href' && !slot.node.runs) prop = propBase(slot.node.name, 'link') + 'Href';
			const stem = RESERVED.has(prop) ? `${prop}Value` : prop;
			prop = stem;
			for (let i = 2; propNames.has(prop); i++) prop = `${stem}${i}`;
			propNames.add(prop);
			props.push({ name: prop, kind: slot.kind, fallback: slot.value });
			bindings.set(slot.node, { ...bindings.get(slot.node), [slot.kind]: prop });
		});

		bindings.set(template, { ...bindings.get(template), className: 'className' });
		const def: ComponentDef = { name, template, props, bindings };
		defs.push(def);
		instances.forEach((instance, i) => {
			const values = perInstance[i];
			const list: [string, string][] = [];
			let p = 0;
			perInstance[0].forEach((slot, index) => {
				const prop = props[p];
				if (!prop) return;
				const binding = bindings.get(slot.node);
				if (binding?.[slot.kind] !== prop.name) return;
				list.push([prop.name, values[index].value]);
				p++;
			});
			uses.set(instance, { def, props: list });
		});
	}
	return { defs, uses };
}
