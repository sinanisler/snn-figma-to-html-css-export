import type { RawNode, ReadResult } from '../shared/types';
import { slugify } from './format';
import { walk, type IRDocument, type IRWarning } from './ir';

export type DesignCheck = {
	/** Share of layers with children that use real Auto Layout, 0–100. */
	score: number;
	containers: number;
	issues: IRWarning[];
};

const CONTAINERS = new Set(['FRAME', 'GROUP', 'COMPONENT', 'INSTANCE', 'SECTION']);

/**
 * Finds what makes a file convert poorly: layers without Auto Layout (positioned
 * absolutely), default layer names, images without alt text and skipped heading levels.
 */
export function checkDesign(result: ReadResult, doc: IRDocument): DesignCheck {
	const issues: IRWarning[] = [];
	let containers = 0;
	let auto = 0;

	const visit = (n: RawNode) => {
		if (n.exportAsset) return;
		if (CONTAINERS.has(n.type) && n.children.length > 0) {
			containers++;
			if (n.autoLayout && !n.autoLayout.inferred) auto++;
			else if (n.type === 'GROUP' && n.children.length > 1) issues.push({ nodeId: n.id, nodeName: n.name, code: 'CHECK_GROUP' });
			else if (n.autoLayout?.inferred) issues.push({ nodeId: n.id, nodeName: n.name, code: 'CHECK_INFERRED_LAYOUT' });
			else if (n.children.length > 1) issues.push({ nodeId: n.id, nodeName: n.name, code: 'CHECK_NO_AUTO_LAYOUT' });
			if (n.children.length > 1 && !slugify(n.name)) issues.push({ nodeId: n.id, nodeName: n.name, code: 'CHECK_GENERIC_NAME' });
			const absolute = n.autoLayout && !n.autoLayout.inferred ? n.children.filter((c) => c.child?.absolute).length : 0;
			if (absolute > 1) issues.push({ nodeId: n.id, nodeName: n.name, code: 'CHECK_ABSOLUTE_CHILDREN', detail: `${absolute} layers` });
		}
		n.children.forEach(visit);
	};
	result.roots.forEach(visit);

	doc.pages.forEach((page) => {
		let last = 0;
		let h1 = 0;
		walk(page.roots, (n) => {
			if (n.tag === 'img' && n.attrs.alt === '' && !n.svgAsset) issues.push({ nodeId: n.id, nodeName: n.name, code: 'CHECK_IMAGE_ALT' });
			const m = /^h([1-6])$/.exec(n.tag);
			if (!m) return;
			const level = Number(m[1]);
			if (level === 1) h1++;
			if (level > last + 1) issues.push({ nodeId: n.id, nodeName: n.name, code: 'CHECK_HEADING_SKIP', detail: `h${last || '–'} → h${level}` });
			last = level;
		});
		if (h1 > 1) issues.push({ nodeId: page.roots[0]?.id ?? '', nodeName: page.name, code: 'CHECK_MULTIPLE_H1', detail: `${h1} × h1` });
	});

	return { score: containers ? Math.round((auto / containers) * 100) : 100, containers, issues };
}
