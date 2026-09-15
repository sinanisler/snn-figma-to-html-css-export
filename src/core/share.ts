import { PLACEMENT_KEYS, TYPO_KEYS } from './diff';
import { cssSlug, slugify, type Style } from './format';
import { walk, type IRDocument, type IRNode } from './ir';

type Group = { label: string; nodes: IRNode[] };

/**
 * Reduces CSS repetition: properties common to every instance of a component, or every
 * text layer using a text style, move to one shared class; nodes whose styles are then
 * identical reuse a single class.
 */
export function shareClasses(doc: IRDocument): void {
	const all: IRNode[] = [];
	const names = new Set<string>();
	doc.pages.forEach((p) =>
		walk(p.roots, (n) => {
			all.push(n);
			if (n.className) names.add(n.className);
			for (const r of n.runs ?? []) if (r.className) names.add(r.className);
		}),
	);
	// Nodes referenced by media, state or pseudo rules keep their own class.
	const pinned = new Set<IRNode>();
	for (const r of doc.rules) {
		pinned.add(r.target);
		if (r.scope) pinned.add(r.scope.node);
	}
	const unique = (base: string) => {
		let name = base;
		for (let i = 2; names.has(name); i++) name = `${base}-${i}`;
		names.add(name);
		return name;
	};

	const groupBy = (key: (n: IRNode) => string | undefined, label: (n: IRNode) => string) => {
		const groups = new Map<string, Group>();
		for (const n of all) {
			const k = key(n);
			if (!k) continue;
			const g = groups.get(k) ?? { label: label(n), nodes: [] };
			g.nodes.push(n);
			groups.set(k, g);
		}
		return groups.values();
	};

	const extract = (groups: Iterable<Group>, include: (k: string) => boolean) => {
		for (const { label, nodes } of groups) {
			if (nodes.length < 2) continue;
			const common: Style = {};
			for (const [k, v] of Object.entries(nodes[0].style))
				if (include(k) && nodes.every((n) => n.style[k] === v)) common[k] = v;
			if (Object.keys(common).length < 2) continue;

			const slug = slugify(label) ?? cssSlug(label, 'shared');
			// A member owning the bare slug hands it over so the shared class reads naturally.
			const owner = nodes.find((n) => n.className === slug);
			if (owner) {
				names.delete(slug);
				owner.className = '';
			}
			const name = unique(slug);
			if (owner) owner.className = unique(`${slug}-1`);

			doc.sharedClasses.push({ name, style: common });
			for (const n of nodes) {
				for (const k of Object.keys(common)) delete n.style[k];
				n.shared.push(name);
				if (Object.keys(n.style).length === 0 && !pinned.has(n)) n.className = '';
			}
		}
	};

	extract(
		groupBy((n) => n.componentKey, (n) => n.componentName ?? 'component'),
		(k) => !PLACEMENT_KEYS.has(k),
	);
	extract(
		groupBy((n) => n.textStyle, (n) => n.textStyle ?? 'text'),
		(k) => TYPO_KEYS.has(k),
	);

	const seen = new Map<string, IRNode>();
	for (const n of all) {
		if (!n.className || pinned.has(n) || Object.keys(n.style).length === 0) continue;
		const key = JSON.stringify([n.shared, Object.entries(n.style)]);
		const first = seen.get(key);
		if (first) n.className = first.className;
		else seen.set(key, n);
	}
}
