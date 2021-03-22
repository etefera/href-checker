import puppeteer, { Browser, Page } from "puppeteer";

export interface Options {
	/** Check existence of fragment links on same page. */
	samePage: boolean;
	/** Check links on same origin. */
	sameSite: boolean;
	/** Check external site links. */
	offSite: boolean;
	/** Check existence of fragment links outside the current page. */
	fragments: boolean;
	/** Allow potential caching of scanned pages. */
	cacheEnabled: boolean;
	/** How many links to check at a time? */
	concurrency: number;
	/** Fail if this text exists on page. */
	badContent?: string;
	puppeteer: {
		timeout: puppeteer.DirectNavigationOptions["timeout"];
		waitUntil: puppeteer.DirectNavigationOptions["waitUntil"];
	};
}

const defaults: Options = {
	samePage: true,
	sameSite: true,
	offSite: true,
	fragments: true,
	cacheEnabled: false,
	concurrency: 5,
	puppeteer: {
		timeout: 20_000,
		waitUntil: "load",
	},
};

export interface Entry {
	input: { link: string; count: number };
	output: Partial<{
		pageExists: boolean;
		status: number;
		fragExists: boolean;
		error: Error;
	}>;
	type: "samePage" | "sameSite" | "offSite";
}

export async function* checkLinks(
	url: URL,
	options: Partial<Options> = {},
): AsyncGenerator<Entry, void, void> {
	const opts = { ...defaults, ...options };
	opts.puppeteer = { ...defaults.puppeteer, ...options.puppeteer };
	if (opts.concurrency < 1 || opts.concurrency > 100) {
		throw new Error(
			`options.concurrency must be between 1-100, got ${opts.concurrency}.`,
		);
	}

	let caughtError;

	const browser = await puppeteer.launch();
	try {
		const page = await browser.newPage();
		await page.setCacheEnabled(opts.cacheEnabled);
		const response = await page.goto(url.href, opts.puppeteer);
		if (!response || !response.ok()) {
			const reason = response ? `. HTTP ${response.status()}` : "";
			throw new Error(`Failed to navigate to ${url}${reason}`);
		}

		const links = await getAllLinks(page, opts);
		for await (const res of checkSamePageLinks(links.samePage, page)) {
			yield { ...res, type: "samePage" };
		}
		for await (const res of checkOffPageLinks(links.sameSite, browser, opts)) {
			yield { ...res, type: "sameSite" };
		}
		for await (const res of checkOffPageLinks(links.offSite, browser, opts)) {
			yield { ...res, type: "offSite" };
		}
	} catch (error) {
		caughtError = error;
	} finally {
		await browser.close();
		if (caughtError) throw caughtError;
	}
}

export async function getAllLinks(page: Page, options: Options) {
	return {
		samePage: count(options.samePage ? await getSamePageLinks(page) : []),
		sameSite: count(options.sameSite ? await getSameSiteLinks(page) : []),
		offSite: count(options.offSite ? await getExternalLinks(page) : []),
	};
}

function getExternalLinks(page: Page) {
	return page.$$eval("a[href]", elems => {
		return (elems as HTMLAnchorElement[])
			.filter(a => /https?:/.test(a.protocol) && a.origin !== location.origin)
			.map(a => a.href);
	});
}

function getSameSiteLinks(page: Page) {
	return page.$$eval("a[href]:not([href^='#'])", elems => {
		return (elems as HTMLAnchorElement[])
			.filter(a => a.origin === location.origin)
			.map(a => a.href);
	});
}

function getSamePageLinks(page: Page) {
	return page.$$eval("a[href^='#']", elems => {
		return (elems as HTMLAnchorElement[]).map(a => a.hash);
	});
}

async function* checkSamePageLinks(links: Map<string, number>, page: Page) {
	for (const [link, count] of links) {
		if (link.length <= 1) continue;
		const fragExists = await isFragmentValid(link, page);
		yield { input: { link, count }, output: { pageExists: true, fragExists } };
	}
}

async function* checkOffPageLinks(
	links: Map<string, number>,
	browser: Browser,
	options: Options,
) {
	const uniqueLinks = [...links.keys()];
	// TODO: retry on TimeoutError
	const resultIterator = pmap(
		link => isLinkValid(link, options, browser),
		uniqueLinks,
		options.concurrency,
	);
	for await (const { input: link, output } of resultIterator) {
		yield { input: { link, count: links.get(link)! }, output };
	}
}

async function isFragmentValid(hash: string, page: Page) {
	const id = hash.replace(/^#/, "");
	const selector = `[id='${id}'], [name='${id}']`;
	try {
		return await page.$eval(selector, el => !!el);
	} catch {
		return false;
	}
}

async function isLinkValid(
	link: string,
	options: Options,
	browser: Browser,
): Promise<
	| { error: Error }
	| { pageExists: boolean; fragExists?: boolean; status?: number }
> {
	const url = new URL(link);
	const page = await browser.newPage();
	try {
		const response = await page.goto(link, options.puppeteer);
		const pageExists = !response || response.ok();
		let fragExists;
		if (options.fragments && pageExists && url.hash && url.hash.length > 1) {
			fragExists = await isFragmentValid(url.hash, page);
		}
		const status = response ? response.status() : undefined;
		if (options.badContent) {
			const html: string = await page.$eval(
				"body",
				e => e.outerHTML,
			);
			if (html.search(options.badContent) !== -1) {
				throw new Error(`Bad content found at ${url}: ${options.badContent}`);
			}
		}
		return { pageExists, fragExists, status };
	} catch (error) {
		return { error };
	} finally {
		await page.close();
	}
}

function count<T>(items: T[]) {
	const counts = new Map<T, number>();
	for (const item of items) {
		const count = counts.get(item) || 0;
		counts.set(item, count + 1);
	}
	return counts;
}

async function* pmap<InputType, OutputType>(
	fn: (input: InputType) => Promise<OutputType>,
	inputs: InputType[],
	concurrency: number,
) {
	type Output = { input: InputType; output: OutputType };
	concurrency = Math.min(concurrency, inputs.length);

	const promises = [];
	const next = (state: { value: number }): Promise<Output> => {
		return new Promise(async resolve => {
			const input = inputs[state.value];
			const output = await fn(input);
			resolve({ input, output });
			state.value += 1;
			if (state.value < inputs.length) {
				const newPromise = next(state);
				promises.push(newPromise);
			}
		});
	};
	const state = { value: 0 }; // "shared memory"
	for (; state.value < concurrency; state.value += 1) {
		promises.push(next(state));
	}

	for (const promise of promises) {
		yield await promise;
	}
}
