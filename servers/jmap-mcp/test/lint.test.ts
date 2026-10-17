import { describe, expect, it } from "vitest";
import { findDeniedActions, stripSieve } from "../src/lint.js";

const DENY = ["redirect", "notify"];

describe("findDeniedActions", () => {
	it("allows ordinary filing rules", () => {
		const script = `require ["fileinto", "mailbox"];\nif address :domain :is "from" "gmail.com" { fileinto :create "Gmail"; }`;
		expect(findDeniedActions(script, DENY)).toEqual([]);
	});

	it("catches redirect, with or without :copy and any case", () => {
		expect(findDeniedActions(`redirect "a@example.org";`, DENY)).toEqual(["redirect"]);
		expect(findDeniedActions(`require "copy"; REDIRECT :copy "a@example.org";`, DENY)).toEqual(["redirect"]);
	});

	it("catches notify through the enotify extension", () => {
		expect(findDeniedActions(`require "enotify"; notify "mailto:a@example.org";`, DENY)).toEqual(["notify"]);
		expect(findDeniedActions(`require ["fileinto","enotify"];`, DENY)).toEqual(["notify"]);
	});

	it("catches redirect extensions that need a require", () => {
		expect(findDeniedActions(`require ["redirect-dsn"];`, DENY)).toEqual(["redirect"]);
	});

	it("ignores denied words in comments, strings and text: blocks", () => {
		const script = [
			"# redirect everything",
			"/* notify me */",
			`fileinto "redirect";`,
			`vacation :subject "please notify me" text:`,
			"redirect to the moon",
			".",
			";",
		].join("\n");
		expect(findDeniedActions(script, DENY)).toEqual([]);
	});

	it("does not treat code after a text: block as hidden", () => {
		const script = `vacation text:\nhello\n.\n;\nredirect "a@example.org";`;
		expect(findDeniedActions(script, DENY)).toEqual(["redirect"]);
	});

	it("honours an empty or custom denylist", () => {
		expect(findDeniedActions(`redirect "a@example.org";`, [])).toEqual([]);
		expect(findDeniedActions(`ereject "no";`, ["ereject"])).toEqual(["ereject"]);
		expect(findDeniedActions(`ereject "no";`, ["reject"])).toEqual([]);
	});
});

describe("stripSieve", () => {
	it("removes comments and strings but keeps code", () => {
		const out = stripSieve(`keep # drop\n"drop" /* drop */ keep2`);
		expect(out).toContain("keep");
		expect(out).toContain("keep2");
		expect(out).not.toContain("drop");
	});
});
