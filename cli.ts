#!/usr/bin/env node
import { checkLinks, Entry } from "./index.js";

const typeHeading = {
	samePage: "Same page links (fragments)",
	sameSite: "Same site links",
	offSite: "External links",
};

async function main() {
	const url = new URL(process.argv[2]);
	console.log(`Navigating to ${url} ...`);
	let lastType;
	for await (const result of checkLinks(url)) {
		if (result.type !== lastType) {
			lastType = result.type;
			const heading = `${typeHeading[result.type]}:`;
			console.log();
			console.log(heading);
			console.log("-".repeat(heading.length));
		}
		const output = formatOutput(result);
		console.log(output);
	}
}

main().catch(error => {
	console.error(error.message);
	process.exit(1);
});

function formatOutput(result: Entry) {
	const { input, output } = result;
	const resultType = getResultType(result);
	let text = getResultEmoji(resultType);
	text += `\t${input.link} [x${input.count}]`;
	if (output.error) {
		text += ` (${output.error})`;
	}
	return text;
}

const enum ResultType {
	ok,
	invalidPage,
	invalidFragment,
	error,
}

function getResultType(result: Entry): ResultType {
	const { error, pageExists, fragExists } = result.output;
	if (error) return ResultType.error;
	if (!pageExists) return ResultType.invalidPage;
	if (typeof fragExists !== "boolean") return ResultType.ok;
	return fragExists ? ResultType.ok : ResultType.invalidFragment;
}

function getResultEmoji(resultType: ResultType) {
	switch (resultType) {
		case ResultType.ok:
			return "✅";
		case ResultType.invalidPage:
			return "❌";
		case ResultType.invalidFragment:
			return "🚧";
		case ResultType.error:
			return "🚨";
	}
}
