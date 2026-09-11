import { strToU8, zipSync, type Zippable } from 'fflate';
import type { RawAsset } from '../shared/types';

/** The async Clipboard API is blocked inside Figma's plugin iframe, so copy via a hidden textarea. */
export function copyText(text: string): boolean {
	const area = document.createElement('textarea');
	area.value = text;
	area.setAttribute('readonly', '');
	area.style.position = 'fixed';
	area.style.opacity = '0';
	document.body.appendChild(area);
	area.select();
	let ok = false;
	try {
		ok = document.execCommand('copy');
	} catch {
		ok = false;
	}
	area.remove();
	return ok;
}

export function downloadZip(
	fileName: string,
	files: { html: string; css: string; assets: RawAsset[] },
): void {
	const entries: Zippable = {
		'index.html': strToU8(files.html),
		'styles.css': strToU8(files.css),
	};
	// Images are already compressed; storing them avoids wasted CPU.
	for (const asset of files.assets) entries[`assets/${asset.name}`] = [asset.bytes, { level: 0 }];
	const data = zipSync(entries, { level: 6 });
	const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/zip' }));
	const link = document.createElement('a');
	link.href = url;
	link.download = fileName;
	document.body.appendChild(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 2000);
}
