import type { FontUse } from './ir';

const WEB_SAFE =
	/^(arial|helvetica|helvetica neue|georgia|times|times new roman|verdana|tahoma|trebuchet ms|courier|courier new|system-ui|impact|comic sans ms)$/i;

/** System or commercial fonts that Google Fonts does not serve. */
const COMMERCIAL =
	/^(sf pro.*|sf mono|sf compact.*|new york|segoe ui.*|avenir.*|futura.*|gill sans.*|proxima nova.*|circular.*|graphik.*|gilroy.*|apple .*|\.sf.*|menlo|monaco|consolas|calibri|cambria|garamond|helvetica .*|neue haas.*|suisse.*|gt .*|aeonik.*|founders grotesk.*)$/i;

export function isWebSafe(family: string): boolean {
	return WEB_SAFE.test(family.trim());
}

export function isCommercial(family: string): boolean {
	return COMMERCIAL.test(family.trim());
}

/** Google Fonts CSS2 URL for every font that could be served by Google, or null. */
export function googleFontsUrl(fonts: FontUse[]): string | null {
	const families = fonts
		.filter((f) => !isWebSafe(f.family) && !isCommercial(f.family))
		.map((f) => {
			const name = f.family.trim().replace(/\s+/g, '+');
			if (f.italicWeights.length === 0) return `family=${name}:wght@${f.weights.join(';')}`;
			const tuples = [
				...f.weights.map((w) => `0,${w}`),
				...f.italicWeights.map((w) => `1,${w}`),
			];
			return `family=${name}:ital,wght@${tuples.join(';')}`;
		});
	return families.length ? `https://fonts.googleapis.com/css2?${families.join('&')}&display=swap` : null;
}

export function fontLinkTags(url: string | null): string {
	if (!url) return '';
	return [
		'<link rel="preconnect" href="https://fonts.googleapis.com">',
		'<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
		`<link rel="stylesheet" href="${url.replace(/&/g, '&amp;')}">`,
	].join('\n');
}
