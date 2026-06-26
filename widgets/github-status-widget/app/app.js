/**
 * GitHub Actions Status Widget for Zoho CRM
 *
 * Shows live workflow run status for the ids-merge-automation repo,
 * filtered to the current Job_Automation_Config record.
 *
 * Filtering: workflow run-name includes "[configRecordId]", so the
 * widget matches runs by checking if the display_title contains the
 * current record's EntityId.
 *
 * Dynamic title: reads the FWC field from the config record and
 * shows it in each run card (e.g. "Create and Link Jobs — testFWC3").
 */

(function () {
    "use strict";

    var OWNER = "theodoroskalfas-maker";
    var REPO = "ids-merge-automation";
    var WORKFLOW_FILE = "%%WORKFLOW_FILE%%";
    var WIDGET_TITLE = "%%WIDGET_TITLE%%";
    var ZOHO_MODULE = "%%ZOHO_MODULE%%";
    var ZOHO_NAME_FIELD = "%%ZOHO_NAME_FIELD%%";
    var API_BASE = "https://api.github.com";
    var RUNS_PER_PAGE = 30;
    var REFRESH_INTERVAL_ACTIVE = 10000;
    var REFRESH_INTERVAL_IDLE = 60000;

    var githubToken = null;
    var refreshTimer = null;
    var entityId = null;
    var fwcName = null;
    var configName = null;
    var recordLabel = null;

    // ---- DOM refs ----
    var $loading = document.getElementById("loadingState");
    var $error = document.getElementById("errorState");
    var $errorMsg = document.getElementById("errorMessage");
    var $empty = document.getElementById("emptyState");
    var $main = document.getElementById("mainContent");
    var $btnRefresh = document.getElementById("btnRefresh");
    var $btnRetry = document.getElementById("btnRetry");
    var $autoRefreshBadge = document.getElementById("autoRefreshBadge");

    var $statTotal = document.getElementById("statTotal");
    var $statSuccess = document.getElementById("statSuccess");
    var $statFailed = document.getElementById("statFailed");
    var $statRunning = document.getElementById("statRunning");

    var $activeRunBanner = document.getElementById("activeRunBanner");
    var $activeRunDuration = document.getElementById("activeRunDuration");
    var $activeRunProgress = document.getElementById("activeRunProgress");
    var $activeRunWorkflow = document.getElementById("activeRunWorkflow");
    var $activeRunLink = document.getElementById("activeRunLink");

    var $runList = document.getElementById("runList");

    // ---- Init ----
    ZOHO.embeddedApp.on("PageLoad", function (data) {
        entityId = data ? data.EntityId : null;
        init();
    });

    ZOHO.embeddedApp.init();

    function init() {
        if (WIDGET_TITLE) {
            document.getElementById("widgetTitle").textContent = WIDGET_TITLE;
        }

        $btnRefresh.addEventListener("click", function () {
            manualRefresh();
        });
        $btnRetry.addEventListener("click", function () {
            manualRefresh();
        });

        loadConfigRecord();
    }

    function loadConfigRecord() {
        if (!entityId) {
            loadToken();
            return;
        }

        ZOHO.CRM.API.getRecord({
            Entity: ZOHO_MODULE,
            RecordID: entityId
        }).then(function (resp) {
            if (resp && resp.data && resp.data.length > 0) {
                var record = resp.data[0];
                fwcName = record.FWC || null;
                configName = record[ZOHO_NAME_FIELD] || record.Name || null;
                recordLabel = configName || fwcName || null;
                if (recordLabel) {
                    document.getElementById("widgetTitle").textContent = WIDGET_TITLE + " — " + recordLabel;
                }
            }
            loadToken();
        }).catch(function () {
            loadToken();
        });
    }

    function loadToken() {
        ZOHO.CRM.API.getOrgVariable("github_pat").then(function (resp) {
            var val = resp && resp.Success && resp.Success.Content;
            if (val && val !== "null" && val.trim() !== "") {
                githubToken = val.trim();
                fetchRuns();
            } else {
                showError('Org variable "github_pat" is not set. Go to Setup > Developer Hub > CRM Variables and create it with your GitHub PAT.');
            }
        }).catch(function () {
            showError('Could not read org variable "github_pat". Make sure the widget has permission to read CRM variables.');
        });
    }

    // ---- GitHub API ----
    function fetchRuns() {
        showLoading();

        var url = API_BASE + "/repos/" + OWNER + "/" + REPO + "/actions/workflows/" + WORKFLOW_FILE + "/runs?per_page=" + RUNS_PER_PAGE;

        ZOHO.CRM.HTTP.get({
            url: url,
            headers: {
                Authorization: "Bearer " + githubToken,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28"
            }
        }).then(function (response) {
            var data;
            try {
                data = typeof response === "string" ? JSON.parse(response) : response;
            } catch (e) {
                showError("Invalid response from GitHub API.");
                return;
            }

            if (data.message) {
                showError("GitHub API: " + data.message);
                return;
            }

            var allRuns = data.workflow_runs || [];

            // Filter runs for this specific config record
            var runs = filterRunsByEntity(allRuns);

            if (runs.length === 0) {
                showEmpty();
                scheduleRefresh(REFRESH_INTERVAL_IDLE);
                return;
            }

            renderRuns(runs);
        }).catch(function (err) {
            showError("Network error: " + (err.message || "Could not reach GitHub API."));
        });
    }

    function filterRunsByEntity(runs) {
        if (!entityId) return runs;

        var filtered = [];
        for (var i = 0; i < runs.length; i++) {
            var title = runs[i].display_title || runs[i].name || "";
            if (title.indexOf("[" + entityId + "]") !== -1) {
                filtered.push(runs[i]);
            }
        }
        return filtered;
    }

    // ---- Render ----
    function renderRuns(runs) {
        var totalCount = runs.length;
        var successCount = 0;
        var failedCount = 0;
        var runningCount = 0;
        var activeRun = null;

        for (var i = 0; i < runs.length; i++) {
            var r = runs[i];
            if (r.conclusion === "success") successCount++;
            else if (r.conclusion === "failure") failedCount++;

            if (r.status === "in_progress" || r.status === "queued" || r.status === "waiting") {
                runningCount++;
                if (!activeRun) activeRun = r;
            }
        }

        $statTotal.textContent = totalCount;
        $statSuccess.textContent = successCount;
        $statFailed.textContent = failedCount;
        $statRunning.textContent = runningCount;

        // Active run banner
        if (activeRun) {
            $activeRunBanner.style.display = "block";
            $activeRunWorkflow.textContent = getRunDisplayName(activeRun);
            $activeRunLink.href = activeRun.html_url;
            $activeRunDuration.textContent = formatDuration(activeRun.run_started_at);

            var elapsed = Date.now() - new Date(activeRun.run_started_at).getTime();
            var estimatedPct = Math.min(95, Math.floor((elapsed / (5 * 60 * 1000)) * 100));
            $activeRunProgress.style.width = estimatedPct + "%";

            $autoRefreshBadge.className = "badge badge-live";
            $autoRefreshBadge.textContent = "LIVE";
            scheduleRefresh(REFRESH_INTERVAL_ACTIVE);
        } else {
            $activeRunBanner.style.display = "none";
            $autoRefreshBadge.className = "badge badge-paused";
            $autoRefreshBadge.textContent = "IDLE";
            scheduleRefresh(REFRESH_INTERVAL_IDLE);
        }

        // Run list
        $runList.innerHTML = "";
        for (var j = 0; j < runs.length; j++) {
            $runList.appendChild(createRunCard(runs[j]));
        }

        showMain();
    }

    function getRunDisplayName(run) {
        var title = run.display_title || run.name || "Workflow #" + run.run_number;
        // Replace the [recordId] tag with human-readable label
        if (entityId) {
            var replacement = recordLabel || fwcName || "";
            title = title.replace(" [" + entityId + "]", replacement ? " " + replacement : "");
        }
        return title;
    }

    function createRunCard(run) {
        var card = document.createElement("div");
        card.className = "run-card";
        card.onclick = function () {
            window.open(run.html_url, "_blank");
        };

        var statusClass = run.status === "completed" ? (run.conclusion || "success") : run.status;
        var displayName = getRunDisplayName(run);

        card.innerHTML =
            '<div class="run-status-icon ' + statusClass + '">' + getStatusSVG(statusClass) + "</div>" +
            '<div class="run-info">' +
                '<div class="run-name">' + escapeHtml(displayName) + "</div>" +
                '<div class="run-meta">' +
                    "<span>#" + run.run_number + "</span>" +
                    "<span>" + formatDate(run.created_at) + "</span>" +
                    "<span>" + capitalise(statusClass) + "</span>" +
                "</div>" +
            "</div>" +
            '<div class="run-duration">' + formatRuntime(run.run_started_at, run.updated_at, run.status) + "</div>";

        return card;
    }

    // ---- Status icons (inline SVG) ----
    function getStatusSVG(status) {
        switch (status) {
            case "success":
                return '<svg viewBox="0 0 16 16" fill="currentColor" width="20" height="20"><path fill-rule="evenodd" d="M8 16A8 8 0 108 0a8 8 0 000 16zm3.78-9.72a.75.75 0 00-1.06-1.06L6.75 9.19 5.28 7.72a.75.75 0 00-1.06 1.06l2 2a.75.75 0 001.06 0l4.5-4.5z"/></svg>';
            case "failure":
                return '<svg viewBox="0 0 16 16" fill="currentColor" width="20" height="20"><path fill-rule="evenodd" d="M2.343 13.657A8 8 0 1113.657 2.343 8 8 0 012.343 13.657zM6.03 4.97a.75.75 0 00-1.06 1.06L6.94 8 4.97 9.97a.75.75 0 101.06 1.06L8 9.06l1.97 1.97a.75.75 0 101.06-1.06L9.06 8l1.97-1.97a.75.75 0 10-1.06-1.06L8 6.94 6.03 4.97z"/></svg>';
            case "cancelled":
                return '<svg viewBox="0 0 16 16" fill="currentColor" width="20" height="20"><path fill-rule="evenodd" d="M4.47.22A.75.75 0 015 0h6a.75.75 0 01.53.22l4.25 4.25c.141.14.22.331.22.53v6a.75.75 0 01-.22.53l-4.25 4.25A.75.75 0 0111 16H5a.75.75 0 01-.53-.22L.22 11.53A.75.75 0 010 11V5a.75.75 0 01.22-.53L4.47.22zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5H5.31zM8 4a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 018 4zm0 8a1 1 0 100-2 1 1 0 000 2z"/></svg>';
            case "in_progress":
                return '<svg viewBox="0 0 16 16" fill="currentColor" width="20" height="20"><path d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1112 0A6 6 0 012 8z" opacity=".3"/><path d="M8 2a6 6 0 016 6h-2a4 4 0 00-4-4V2z"><animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="1s" repeatCount="indefinite"/></path></svg>';
            case "queued":
            case "waiting":
                return '<svg viewBox="0 0 16 16" fill="currentColor" width="20" height="20"><path fill-rule="evenodd" d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8zm8-3.25a.75.75 0 01.75.75v2.69l1.78 1.78a.75.75 0 11-1.06 1.06l-2-2A.75.75 0 017.25 8.5v-3a.75.75 0 01.75-.75z"/></svg>';
            default:
                return '<svg viewBox="0 0 16 16" fill="currentColor" width="20" height="20"><circle cx="8" cy="8" r="6" opacity=".3"/></svg>';
        }
    }

    // ---- Helpers ----
    function formatDuration(startedAt) {
        if (!startedAt) return "";
        var ms = Date.now() - new Date(startedAt).getTime();
        return formatMs(ms);
    }

    function formatRuntime(startedAt, updatedAt, status) {
        if (!startedAt) return "-";
        var end = (status === "completed" || status === "cancelled") ? new Date(updatedAt) : new Date();
        var ms = end.getTime() - new Date(startedAt).getTime();
        return formatMs(ms);
    }

    function formatMs(ms) {
        if (ms < 0) ms = 0;
        var sec = Math.floor(ms / 1000);
        var min = Math.floor(sec / 60);
        var hr = Math.floor(min / 60);
        sec = sec % 60;
        min = min % 60;
        if (hr > 0) return hr + "h " + min + "m";
        if (min > 0) return min + "m " + sec + "s";
        return sec + "s";
    }

    function formatDate(iso) {
        if (!iso) return "";
        var d = new Date(iso);
        var day = String(d.getDate()).padStart(2, "0");
        var mon = String(d.getMonth() + 1).padStart(2, "0");
        var hr = String(d.getHours()).padStart(2, "0");
        var mn = String(d.getMinutes()).padStart(2, "0");
        return day + "/" + mon + " " + hr + ":" + mn;
    }

    function capitalise(str) {
        if (!str) return "";
        return str.charAt(0).toUpperCase() + str.slice(1).replace(/_/g, " ");
    }

    function escapeHtml(str) {
        var div = document.createElement("div");
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

    // ---- State management ----
    function showLoading() {
        $loading.style.display = "flex";
        $error.style.display = "none";
        $empty.style.display = "none";
        $main.style.display = "none";
    }

    function showError(msg) {
        $loading.style.display = "none";
        $error.style.display = "flex";
        $errorMsg.textContent = msg;
        $empty.style.display = "none";
        $main.style.display = "none";
        stopRefresh();
    }

    function showEmpty() {
        $loading.style.display = "none";
        $error.style.display = "none";
        $empty.style.display = "flex";
        $main.style.display = "none";
    }

    function showMain() {
        $loading.style.display = "none";
        $error.style.display = "none";
        $empty.style.display = "none";
        $main.style.display = "block";
    }

    // ---- Refresh ----
    function scheduleRefresh(interval) {
        stopRefresh();
        refreshTimer = setTimeout(function () {
            fetchRuns();
        }, interval);
    }

    function stopRefresh() {
        if (refreshTimer) {
            clearTimeout(refreshTimer);
            refreshTimer = null;
        }
    }

    function manualRefresh() {
        $btnRefresh.classList.add("spinning");
        setTimeout(function () {
            $btnRefresh.classList.remove("spinning");
        }, 800);
        fetchRuns();
    }
})();
