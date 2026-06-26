# Build 3 workflow-specific Zoho CRM widget ZIPs from the shared template.
# Each ZIP gets its own WORKFLOW_FILE and WIDGET_TITLE baked in.

$widgets = @(
    @{ Name = "github_mass_create_widget";   WorkflowFile = "create-and-link-jobs-workflow.yml";  Title = "Mass Create Jobs" },
    @{ Name = "github_merge_jobs_widget";    WorkflowFile = "merge-jobs-workflow.yml";            Title = "Merge Jobs" },
    @{ Name = "github_cleanup_dupes_widget"; WorkflowFile = "cleanup-duplicates-workflow.yml";    Title = "Cleanup Duplicates" }
)

$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$templateJs = Get-Content -Path "$scriptDir\app\app.js" -Raw -Encoding UTF8
$distDir    = "$scriptDir\dist"

if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir -Force | Out-Null }

Add-Type -AssemblyName "System.IO.Compression"

foreach ($w in $widgets) {
    $zipPath = "$distDir\$($w.Name).zip"
    if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force -Confirm:$false }

    $customJs = $templateJs.Replace('%%WORKFLOW_FILE%%', $w.WorkflowFile).Replace('%%WIDGET_TITLE%%', $w.Title)

    $fs = New-Object System.IO.FileStream($zipPath, [System.IO.FileMode]::Create)
    $archive = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create, $false)

    # Add all files from app/ except app.js (we inject the customized version)
    $appDir = "$scriptDir\app"
    $files = Get-ChildItem -Path $appDir -Recurse -File | Where-Object { $_.Name -ne "app.js" }

    foreach ($file in $files) {
        $entryName = "app/" + $file.FullName.Substring($appDir.Length + 1).Replace("\", "/")
        $entry = $archive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
        $es = $entry.Open()
        $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
        $es.Write($bytes, 0, $bytes.Length)
        $es.Close()
    }

    # Add customized app.js
    $entry = $archive.CreateEntry("app/app.js", [System.IO.Compression.CompressionLevel]::Optimal)
    $es = $entry.Open()
    $jsBytes = [System.Text.Encoding]::UTF8.GetBytes($customJs)
    $es.Write($jsBytes, 0, $jsBytes.Length)
    $es.Close()

    $archive.Dispose()
    $fs.Dispose()

    Write-Host "Built: $($w.Name).zip  ->  $($w.Title)  ($($w.WorkflowFile))"
}

Write-Host "`nAll 3 widget ZIPs are in: $distDir"
