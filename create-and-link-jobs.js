/**
 * create-and-link-jobs.js
 *
 * Why this exists: this is the sibling of merge-jobs.js, same reason.
 * The old monolithic Deluge function (Process_Single_View_From_Config /
 * Bulk_Create_Jobs_OPTIMIZED) hit Zoho's 5-minute button timeout and
 * 200k Deluge statement limit once the linked Relaties view got into
 * the thousands of records — and even within those limits, it never
 * actually linked Campagnes_Orderlijst (multi-select lookup fields
 * can't be set via bulkCreate/updateRecord) or renamed Jobs per the
 * documented "{Campaign} I {Campaign}-{AutoNumber}" convention.
 *
 * This script moves ALL of that outside Zoho, to GitHub Actions, where
 * none of those limits apply, and does it in three chained stages so
 * Job ID + campaign ID data flows directly from stage to stage with no
 * redundant Zoho lookups:
 *
 *   Stage 1 (once):       get_relaties_for_create
 *                          -> viewName, fwcMap, campaignMap, relatieBatches[]
 *   Stage 2 (per Relatie): create_jobs_for_relatie
 *                          -> jobsCreated[] (jobId + campaignIds per Job)
 *   Stage 3 (per Job):     link_and_rename_job
 *                          -> links Campagnes_Orderlijst, renames Job
 *
 * Stage 3 is independently re-runnable: pass JOB_LINK_QUEUE_JSON (an
 * array of {jobId, campaignIds, campaignNames}) to skip stages 1-2 and
 * retry just the link/rename step on a known set of Jobs.
 *
 * Required environment variables (set as GitHub Actions secrets/inputs):
 *   ZOHO_API_KEY        - the zapikey for all three standalone functions
 *   CONFIG_RECORD_ID     - the Job_Automation_Config record ID to process
 *                          (passed in at workflow-dispatch time)
 *   JOB_LINK_QUEUE_JSON  - OPTIONAL. If set, skips stages 1-2 entirely and
 *                          runs stage 3 only, on this explicit list.
 *
 * Usage (local testing):
 *   ZOHO_API_KEY=xxx CONFIG_RECORD_ID=621419000050140200 node create-and-link-jobs.js
 */

const ZOHO_API_KEY = process.env.ZOHO_API_KEY;
const CONFIG_RECORD_ID = process.env.CONFIG_RECORD_ID;
const JOB_LINK_QUEUE_JSON = process.env.JOB_LINK_QUEUE_JSON;

const BASE_URL = "https://sandbox.zohoapis.eu/crm/v7/functions";
// NOTE: switch to the production function-execute domain when going live.
// Sandbox and production use different generated REST URLs in Zoho CRM —
// confirm the production URL from the function's own "REST API" settings
// dialog before flipping this, do not guess the domain. Same caveat as
// merge-jobs.js.

const RETRY_LIMIT = 3;
const RETRY_DELAY_MS = 2000;
const DELAY_BETWEEN_CALLS_MS = 300; // gentle pacing to avoid API rate limits

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callZohoFunction(functionApiName, params) {
	const url = new URL(`${BASE_URL}/${functionApiName}/actions/execute`);
	url.searchParams.set("auth_type", "apikey");
	url.searchParams.set("zapikey", ZOHO_API_KEY);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}

	let lastError = null;
	for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
		try {
			const response = await fetch(url.toString(), { method: "POST" });
			const data = await response.json();

			// Zoho REST API returns two possible shapes:
			//   Wrapped:   { response: { code, details: { output } } }
			//   Unwrapped: { code, details: { output } }
			const inner = data?.response ?? data;
			if (inner?.code === "success") {
				return inner.details.output;
			}

			lastError = new Error(
				`Zoho function ${functionApiName} returned non-success: ${JSON.stringify(data)}`
			);
		} catch (err) {
			lastError = err;
		}

		if (attempt < RETRY_LIMIT) {
			console.warn(
				`  Attempt ${attempt} failed for ${functionApiName}(${JSON.stringify(params)}). Retrying in ${RETRY_DELAY_MS}ms...`
			);
			await sleep(RETRY_DELAY_MS);
		}
	}

	throw lastError;
}

async function runCreateStage() {
	console.log("=== Stage 1: get_relaties_for_create ===");
	const viewRaw = await callZohoFunction("get_relaties_for_create", {
		configRecordId: CONFIG_RECORD_ID,
	});
	const viewData = typeof viewRaw === "string" ? JSON.parse(viewRaw) : viewRaw;

	if (viewData.error) {
		throw new Error(`get_relaties_for_create returned an error: ${viewData.error}`);
	}

	console.log(`View: ${viewData.viewName} | Relaties to process: ${viewData.relatieCount}`);

	// Zoho's map.toString() flattens nested lists, so the deployed function
	// returns relatieIds as a flat array (not the relatieBatches the .dg
	// source code puts in the map). Use whichever key is present.
	const relatieIds = viewData.relatieIds
		|| (viewData.relatieBatches && viewData.relatieBatches.flat());

	if (!relatieIds || !Array.isArray(relatieIds)) {
		console.error("Stage 1 response (first 2000 chars):", JSON.stringify(viewData).slice(0, 2000));
		throw new Error(
			`get_relaties_for_create returned no relatieIds. Keys found: ${Object.keys(viewData).join(", ")}`
		);
	}

	const fwcMapJson = JSON.stringify(viewData.fwcMap);
	const campaignMapJson = JSON.stringify(viewData.campaignMap);
	// Reverse map (id -> name) so stage 3 can build the rename string
	// without a second Zoho lookup.
	const campaignIdToName = {};
	for (const [name, id] of Object.entries(viewData.campaignMap)) {
		campaignIdToName[id] = name;
	}

	console.log("=== Stage 2: create_jobs_for_relatie (looped) ===");
	const jobLinkQueue = [];
	let processed = 0;
	let skipped = 0;
	let createErrors = 0;

	for (const relatieId of relatieIds) {
		try {
			const raw = await callZohoFunction("create_jobs_for_relatie", {
				relatieId,
				fwcMapJson,
				campaignMapJson,
			});
			const result = typeof raw === "string" ? JSON.parse(raw) : raw;

			if (result.skipped) {
				skipped++;
			} else {
				for (const job of result.jobsCreated) {
					jobLinkQueue.push({
						jobId: job.jobId,
						campaignIds: job.campaignIds,
						campaignNames: job.campaignIds.map(
							(id) => campaignIdToName[id] || id
						),
					});
				}
			}

			if (result.errors && result.errors.length > 0) {
				createErrors += result.errors.length;
				console.warn(`  Relatie ${relatieId} errors: ${result.errors.join("; ")}`);
			}
		} catch (err) {
			createErrors++;
			console.error(`  Relatie ${relatieId} failed entirely: ${err.message}`);
		}

		processed++;
		if (processed % 50 === 0 || processed === relatieIds.length) {
			console.log(
				`  Progress: ${processed}/${relatieIds.length} Relaties | ${jobLinkQueue.length} Jobs created so far`
			);
		}

		await sleep(DELAY_BETWEEN_CALLS_MS);
	}

	console.log(
		`Stage 2 complete. Processed: ${processed} | Skipped: ${skipped} | Errors: ${createErrors} | Jobs to link: ${jobLinkQueue.length}`
	);

	return jobLinkQueue;
}

async function runLinkStage(jobLinkQueue) {
	console.log("=== Stage 3: link_and_rename_job (looped) ===");
	let linked = 0;
	let renamed = 0;
	let linkErrors = 0;

	for (let i = 0; i < jobLinkQueue.length; i++) {
		const job = jobLinkQueue[i];
		try {
			const raw = await callZohoFunction("link_and_rename_job", {
				jobId: job.jobId,
				campaignIdsJson: JSON.stringify(job.campaignIds),
				campaignNamesJson: JSON.stringify(job.campaignNames),
			});
			const result = typeof raw === "string" ? JSON.parse(raw) : raw;

			if (result.linked) linked++;
			if (result.renamed) renamed++;
			if (result.errors && result.errors.length > 0) {
				linkErrors += result.errors.length;
				console.warn(`  Job ${job.jobId} errors: ${result.errors.join("; ")}`);
			}
		} catch (err) {
			linkErrors++;
			console.error(`  Job ${job.jobId} failed entirely: ${err.message}`);
		}

		if ((i + 1) % 50 === 0 || i === jobLinkQueue.length - 1) {
			console.log(`  Progress: ${i + 1}/${jobLinkQueue.length} Jobs linked/renamed`);
		}

		await sleep(DELAY_BETWEEN_CALLS_MS);
	}

	console.log(
		`Stage 3 complete. Linked: ${linked} | Renamed: ${renamed} | Errors: ${linkErrors}`
	);
}

async function main() {
	if (!ZOHO_API_KEY) {
		console.error("Missing required environment variable ZOHO_API_KEY.");
		process.exit(1);
	}

	let jobLinkQueue;

	if (JOB_LINK_QUEUE_JSON) {
		console.log("JOB_LINK_QUEUE_JSON provided — skipping stages 1-2, retrying link/rename only.");
		jobLinkQueue = JSON.parse(JOB_LINK_QUEUE_JSON);
	} else {
		if (!CONFIG_RECORD_ID) {
			console.error("Missing required environment variable CONFIG_RECORD_ID.");
			process.exit(1);
		}
		jobLinkQueue = await runCreateStage();
	}

	if (jobLinkQueue.length === 0) {
		console.log("No Jobs need linking/renaming. Done.");
		return;
	}

	await runLinkStage(jobLinkQueue);

	console.log("=== Full run complete ===");
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
