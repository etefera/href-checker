#!/usr/bin/env node
import sade from "sade";
import { readFileSync } from "fs";

import { checkLinks } from "./index.js";

import { Entry, Options } from "./index.js";
import { DirectNavigationOptions } from "puppeteer";

interface CommandLineOptions {
	"same-page": boolean;
	"same-site": boolean;
	"off-site": boolean;
	fragments: boolean;
	timeout: number;
	"wait-until": DirectNavigationOptions["waitUntil"];
	format: "json" | "pretty";
	emoji: boolean;
}

sade("hyperlinkinator <url>", true)
	.version(JSON.parse(readFileSync("./package.json", "utf-8")).version)
	.option("--same-page", "Check same-page (fragment) links", true)
	.option("--same-site", "Check same-site links", true)
	.option("--off-site", "Check external links", true)
	.option(
		"--fragments",
		"Check for existence of IDs corresponding to fragments",
		true,
	)
	.option("--timeout", "Timeout (in seconds) for navigation", 20)
	.option(
		"--wait-until",
		'Wait until either "load", "domcontentloaded", "networkidle0", "networkidle2" events.',
		"load",
	)
	.option("--format", "Format output as pretty or json", "pretty")
	.option("--emoji", "Use emoji in output (with --format=pretty)", true)
	.action(async (url: string, options: CommandLineOptions) => {
		try {
			await main(new URL(url), {
				options: {
					samePage: options["same-page"],
					sameSite: options["same-site"],
					offSite: options["off-site"],
					fragments: options.fragments,
					puppeteer: {
						timeout: options.timeout * 1000,
						waitUntil: options["wait-until"],
					},
				},
				outputOptions: {
					emoji: options.emoji,
					format: options.format || "pretty",
				},
			});
		} catch (error) {
			console.error(error.message);
			process.exit(1);
		}
	})
	.parse(process.argv);

interface Opts {
	options: Options;
	outputOptions: {
		emoji: CommandLineOptions["emoji"];
		format: CommandLineOptions["format"];
	};
}
async function main(url: URL, { options, outputOptions }: Opts) {
	console.log(`Navigating to ${url} ...`);
	for await (const result of checkLinks(url, options)) {
		const output = formatOutput(result, outputOptions);
		console.log(output);
	}
}

function formatOutput(result: Entry, options: Opts["outputOptions"]) {
	const { input, output } = result;
	const resultType = getResultType(result);
	const status = options.emoji
		? getResultEmoji(resultType)
		: getResultText(resultType);
	let text = `[${result.type}]\t${status}\t${input.link} [x${input.count}]`;
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

function getResultText(resultType: ResultType) {
	switch (resultType) {
		case ResultType.ok:
			return "ok";
		case ResultType.invalidPage:
			return "fail";
		case ResultType.invalidFragment:
			return "warn";
		case ResultType.error:
			return "err";
	}
}
