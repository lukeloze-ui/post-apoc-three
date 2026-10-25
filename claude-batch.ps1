<#
.SYNOPSIS
  Batch-run small tasks through Claude Code, one fresh session per task.

.DESCRIPTION
  1. Either reads a task plan (-PlanFile, see Tools/plans/*.json), or reads a numbered feature list
     (-Features: "1." or "1)"; a feature may span several lines until the next number; '#' lines ignored)
     and asks Claude (read-only) to break it into small tasks, written to plan.json in the run's log folder.
  2. Runs each task in its OWN fresh Claude session, with the model and effort the plan picked for it.
     Short sessions are what keep the cost down: every turn re-sends the whole conversation, so a
     150-turn session costs many times what five 30-turn ones do.
  3. On a usage limit it waits for the reset and then starts a FRESH session that picks the task up
     from the working tree (resuming the old one would rebuild its whole expired cache).
  4. Marks each finished task "done" in the plan file, with its summary; with -Commit it also commits
     (and pushes) after each task.
     Rerunning the same command carries on from the first task not done.
     A failed task stops the run, so later tasks don't build on a broken tree.

  Plan format:
  {"name":"...", "common":"notes every task gets (build command, test tips)", "tasks":[{"area":"Bunkers","name":"short name","model":"claude-sonnet-5-5","effort":"high",
     "brief":"files/functions to start from and what's known",
     "task":"what to do", "check":"how to prove it works", "done":false}]}
  Old {"groups":[...]} plans still load: each feature becomes a task.

.EXAMPLE
  .\Tools\claude-batch.ps1 -PlanFile Tools\plans\next.json -Commit -SkipPermissions
  .\Tools\claude-batch.ps1 -PlanFile Tools\plans\next.json -PlanOnly        # list tasks and what's done
  .\Tools\claude-batch.ps1 -PlanFile Tools\plans\next.json -Only 12          # run just task 12
  .\Tools\claude-batch.ps1 -Features features.txt -PlanOnly                  # break features into tasks
#>
param(
    [string]$Features,
    [string]$PlanFile,
    [switch]$PlanOnly,
    [switch]$Commit,
    [switch]$SkipPermissions,
    [string]$Model = "claude-opus-5-5",   # planner model; also the default for a task with none
    [string]$Effort = "high",             # planner effort; also the default for a task with none
    [switch]$FixedModel,                  # ignore the plan's per-task model/effort picks
    [int]$StartAt = 0,                    # task number to start from (default: the first not done)
    [int]$Only = 0,                       # run just this task number
    [int]$Count = 0,                      # stop after this many tasks (0 = all)
    [switch]$NoPush
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = (git rev-parse --show-toplevel).Trim()
Set-Location $root

$runDir = Join-Path $root ("Tools\batch-logs\" + (Get-Date -Format "yyyyMMdd-HHmmss"))
New-Item -ItemType Directory -Force $runDir | Out-Null

# Append a line to a log file, sharing it with readers (tail/grep, editors, the inner Claude) and retrying
# briefly if someone holds it locked. A log write must never fail a task.
function Add-LogLine([string]$Path, [string]$Text) {
    $share = [System.IO.FileShare]"ReadWrite, Delete"
    for ($i = 0; $i -lt 20; $i++) {
        try {
            $fs = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, $share)
            $w = New-Object System.IO.StreamWriter($fs, (New-Object System.Text.UTF8Encoding($false)))
            $w.WriteLine($Text); $w.Close(); return
        } catch [System.IO.IOException] { Start-Sleep -Milliseconds 250 }
    }
    Write-Host "  (couldn't write to $Path - line dropped)"
}

function Log([string]$Text) {
    Write-Host $Text
    Add-LogLine (Join-Path $runDir "run.log") $Text
}

function Invoke-Claude([string]$Prompt, [switch]$ReadOnly, [string]$UseModel = $Model, [string]$UseEffort = $Effort) {
    $cargs = @("-p", "--output-format", "stream-json", "--verbose")
    if ($UseModel) { $cargs += @("--model", $UseModel) }
    if ($UseEffort -eq "max") { $UseEffort = "xhigh" }   # never above xhigh: max costs too many tokens for marginal gain
    if ($UseEffort) { $cargs += @("--effort", $UseEffort) }
    if ($ReadOnly) { $cargs += @("--permission-mode", "plan") }
    elseif ($SkipPermissions) { $cargs += "--dangerously-skip-permissions" }
    else { $cargs += @("--permission-mode", "acceptEdits") }
    # Stream events as they arrive: raw JSON to claude-stream.jsonl, readable text/tool calls to run.log.
    # Once the final "result" event arrives, stop waiting: claude.exe has been seen to hang after finishing.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = (Get-Command claude).Source
    $psi.Arguments = ($cargs | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }) -join " "
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.WorkingDirectory = $root
    $proc = [System.Diagnostics.Process]::Start($psi)
    $stdin = New-Object System.IO.StreamWriter($proc.StandardInput.BaseStream, (New-Object System.Text.UTF8Encoding($false)))
    $stdin.Write($Prompt); $stdin.Close()
    $streamLog = Join-Path $runDir "claude-stream.jsonl"
    $result = $null; $other = @()
    while ($null -ne ($line = $proc.StandardOutput.ReadLine())) {
        Add-LogLine $streamLog $line
        try { $ev = $line | ConvertFrom-Json } catch { $other += $line; continue }
        if ($ev.type -eq "assistant") {
            foreach ($c in $ev.message.content) {
                if ($c.type -eq "text" -and $c.text.Trim()) { Log "  [claude] $($c.text.Trim())" }
                elseif ($c.type -eq "tool_use") {
                    $inp = ($c.input | ConvertTo-Json -Compress -Depth 5)
                    if ($inp.Length -gt 200) { $inp = $inp.Substring(0, 200) + "..." }
                    Log "  [tool] $($c.name) $inp"
                }
            }
        } elseif ($ev.type -eq "result") {
            # A resumed session has been seen to replay the previous result (0 turns, no API time) before
            # doing any work. Taking that as the answer killed the real run, so skip it and keep reading.
            if ([int]$ev.num_turns -eq 0 -and [int]$ev.duration_api_ms -eq 0 -and -not $ev.is_error) {
                Log "  (skipped a stale 0-turn result)"; continue
            }
            $result = $ev; break
        }
    }
    if (-not $proc.WaitForExit(30000)) { Log "  (claude didn't exit after its result - killing it)"; $proc.Kill() }
    if (-not $result) {
        $msg = $other -join "`n"
        if (Test-UsageLimit $msg) { return [pscustomobject]@{ is_error = $true; result = $msg; session_id = ""; total_cost_usd = 0; num_turns = 0 } }
        throw "claude exited $($proc.ExitCode) with no result`n$msg"
    }
    return $result
}

function Test-UsageLimit([string]$Text) {
    return $Text -match '(usage|rate|session|weekly)\s+limit|hit your limit|limit reached'
}

# Sleep until the reset time named in a usage-limit message (epoch after '|', or "resets 3pm" / "resets at 15:30"),
# falling back to 30 minutes when no time can be read. Adds a couple of minutes' margin.
function Wait-UsageLimit([string]$Text) {
    $until = $null
    if ($Text -match '\|(\d{9,})') { $until = [DateTimeOffset]::FromUnixTimeSeconds([long]$Matches[1]).LocalDateTime }
    elseif ($Text -match 'resets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)?') {
        $h = [int]$Matches[1]; $m = if ($Matches[2]) { [int]$Matches[2] } else { 0 }
        if ($Matches[3] -eq 'pm' -and $h -lt 12) { $h += 12 } elseif ($Matches[3] -eq 'am' -and $h -eq 12) { $h = 0 }
        $until = (Get-Date).Date.AddHours($h).AddMinutes($m)
        if ($until -lt (Get-Date)) { $until = $until.AddDays(1) }
    }
    if (-not $until -or $until -lt (Get-Date)) { $until = (Get-Date).AddMinutes(30) }
    $until = $until.AddMinutes(2)
    Log "  USAGE LIMIT hit - waiting until $($until.ToString('ddd HH:mm')) ($Text)"
    Start-Sleep -Seconds ([Math]::Max(60, ($until - (Get-Date)).TotalSeconds))
}

# Invoke-Claude, but on a usage limit wait for the reset and start a FRESH session that picks the work up
# from the working tree. Resuming the old session would re-send (and, with the cache long expired, re-write)
# its whole context, which cost more than the work left. Other errors throw.
function Invoke-ClaudeRetry([string]$Prompt, [switch]$ReadOnly, [string]$UseModel = $Model, [string]$UseEffort = $Effort) {
    $p = $Prompt; $cost = 0.0; $turns = 0
    while ($true) {
        $res = Invoke-Claude $p -ReadOnly:$ReadOnly -UseModel $UseModel -UseEffort $UseEffort
        $cost += [double]$res.total_cost_usd; $turns += [int]$res.num_turns
        if (-not $res.is_error) { $res.total_cost_usd = $cost; $res.num_turns = $turns; return $res }
        if (-not (Test-UsageLimit $res.result)) { throw "claude error: $($res.result)" }
        Wait-UsageLimit $res.result
        if ($res.session_id -and -not $ReadOnly) {
            $p = $Prompt + "`n`nNOTE: an earlier session on this task was cut off by a usage limit partway through. " +
                 "Its uncommitted edits are in the working tree: start with git status and git diff, keep what is right, and finish the task."
        }
    }
}

function Save-Plan {
    if (-not $planPath) { return }
    $plan | ConvertTo-Json -Depth 10 | Set-Content $planPath -Encoding utf8
}

# ---------- 1. Plan ----------
$planPath = $null
if ($PlanFile) {
    $planPath = (Resolve-Path $PlanFile).Path
    $plan = Get-Content $planPath -Raw | ConvertFrom-Json
} else {
    if (-not $Features) { throw "Pass -Features <file> or -PlanFile <plan.json>" }
    # A line starting "N." or "N)" begins a feature; following lines belong to it until the next number.
    $list = @(); $cur = $null
    foreach ($line in Get-Content $Features) {
        if ($line.Trim().StartsWith("#")) { continue }
        if ($line -match '^\s*\d+\s*[\.\)]\s*(.*)$') {
            if ($cur) { $list += $cur.Trim() }
            $cur = $Matches[1]
        } elseif ($null -ne $cur) {
            $cur += "`n" + $line
        }
    }
    if ($cur) { $list += $cur.Trim() }
    $numbered = ($list | ForEach-Object -Begin { $i = 0 } -Process { $i++; "$i. $_" }) -join "`n"

    $planPrompt = @"
You are planning a batch of work on this repository. Do NOT change any files.
Look at the codebase only as much as you need to know which files and systems each feature touches.

Break these features into SMALL tasks. Each task runs in its own fresh Claude session that knows nothing
but what you write for it, so:
- One concern per task, about 15-40 turns of work: a developer's half-day ticket, not an epic. A big
  feature becomes many tasks; a small tweak stays one. Don't split so fine that a task is mostly reading.
- Order tasks so each builds on committed earlier ones (foundations and shared helpers first).
- "brief": the exact files, classes and functions to start from, and anything learned while planning,
  so the session doesn't have to explore. "check": the cheapest proof it works (a build, one named
  test or autopilot target, a screenshot) - not every test there is.
- Pick the model and effort per task, as low as will do the job well:
  "claude-sonnet-5-5" for contained work that follows existing patterns; "claude-opus-5-5" for design,
  cross-cutting or subtle work. effort "medium" or "high" usually; "xhigh" only for the rare task that
  really needs deep thought. Never "max".

Features:
$numbered

Reply with ONLY JSON, no prose, no code fences, in this shape:
{"name":"short plan name","tasks":[{"area":"feature area","name":"short task name","model":"claude-sonnet-5-5","effort":"high","brief":"...","task":"...","check":"..."}]}
"@
    Log "Planning $($list.Count) features..."
    $res = Invoke-ClaudeRetry $planPrompt -ReadOnly
    $json = $res.result -replace '(?s)^.*?(\{.*\}).*$', '$1'
    $plan = $json | ConvertFrom-Json
    $planPath = Join-Path $runDir "plan.json"
    Save-Plan
}

# Old plans: {"groups":[{name, model, effort, context, features[]}]} -> one task per feature.
if (-not $plan.tasks -and $plan.groups) {
    $tasks = @()
    foreach ($g in $plan.groups) {
        foreach ($f in $g.features) {
            $tasks += [pscustomobject]@{ area = $g.name; name = $g.name; model = $g.model; effort = $g.effort; brief = $g.context; task = $f; check = "" }
        }
    }
    $plan = [pscustomobject]@{ name = "converted plan"; tasks = $tasks }
    $planPath = Join-Path $runDir "plan.json"   # don't overwrite the old-format file
    Save-Plan
}

$tasks = @($plan.tasks)
for ($i = 0; $i -lt $tasks.Count; $i++) {
    $t = $tasks[$i]
    $mark = if ($t.done) { "[done]" } else { "      " }
    $m = if ($FixedModel -or -not $t.model) { $Model } else { $t.model }
    $e = if ($FixedModel -or -not $t.effort) { $Effort } else { $t.effort }
    Log ("{0} {1,3}. [{2}] {3}  ({4} / {5})" -f $mark, ($i + 1), $t.area, $t.name, ($m -replace '^claude-', ''), $e)
}
if ($PlanOnly) { Log "`nPlan: $planPath (edit it and rerun with -PlanFile)."; return }

# ---------- 2. Execute ----------
$first = if ($Only) { $Only - 1 } elseif ($StartAt) { $StartAt - 1 } else { 0 }
$ran = 0; $totalCost = 0.0
for ($i = $first; $i -lt $tasks.Count; $i++) {
    $t = $tasks[$i]
    if ($Only -and $i -ne $Only - 1) { break }
    if ($t.done -and -not $Only) { continue }
    if ($Count -and $ran -ge $Count) { break }
    $ran++
    $tModel = if ($FixedModel -or -not $t.model) { $Model } else { $t.model }
    $tEffort = if ($FixedModel -or -not $t.effort) { $Effort } else { $t.effort }
    Log "`n######## Task $($i + 1)/$($tasks.Count): [$($t.area)] $($t.name)   ($tModel / $tEffort) ########"

    # What earlier tasks in the same area did (their summaries), so this one needn't rediscover it.
    $before = @($tasks[0..([Math]::Max(0, $i - 1))] | Where-Object { $_.done -and $_.area -eq $t.area -and $_.summary } | Select-Object -Last 4)
    if ($i -eq 0) { $before = @() }
    $beforeText = if ($before.Count) { ($before | ForEach-Object { "- $($_.name): $($_.summary)" }) -join "`n" } else { "(none)" }
    $check = if ($t.check) { $t.check } else { "Build it, and check it the cheapest way that proves it works." }

    $prompt = @"
You are doing ONE small task in this repository, in a fresh session. Plan: $($plan.name). Task $($i + 1) of $($tasks.Count), area "$($t.area)".

$(if ($plan.common) { "About this project: $($plan.common)`n" })
Where to start (trust this - read these, don't survey the codebase):
$($t.brief)

Earlier tasks in this area (already committed):
$beforeText

The task: $($t.task)

How to check it: $check

Rules:
- Do this task only. If you find something else that needs doing, say so in your summary instead of doing it.
- Keep reading targeted, and run only the checks named above (one build, the named test or run).
- Work autonomously; don't ask questions - make sensible choices and note them. Don't commit.
- Finish with a summary of at most 3 lines: what changed, how it was checked, anything left undone.
"@
    $start = Get-Date
    try {
        $res = Invoke-ClaudeRetry $prompt -UseModel $tModel -UseEffort $tEffort
    } catch {
        Log "FAILED: $_"
        Log "Stopping: the working tree holds this task's partial edits. Fix or revert them, then rerun the same command."
        break
    }
    $totalCost += [double]$res.total_cost_usd
    Log $res.result
    Log ("    (cost `${0:N2}, {1} turns, {2:N0} min)" -f $res.total_cost_usd, $res.num_turns, ((Get-Date) - $start).TotalMinutes)
    $summary = ($res.result -replace '\s+', ' ').Trim()
    if ($summary.Length -gt 600) { $summary = $summary.Substring($summary.Length - 600) }
    $t | Add-Member -NotePropertyName summary -NotePropertyValue $summary -Force
    # Mark done before committing so the plan file's own change goes into this task's commit.
    $t | Add-Member -NotePropertyName done -NotePropertyValue $true -Force
    Save-Plan

    if ($Commit) {
        $ErrorActionPreference = "Continue"   # git writes progress to stderr; with Stop, 2>&1 would throw
        # The batch logs stay out of task commits (the stream log alone runs to tens of MB).
        git add -A -- . ":(exclude,icase)Tools/batch-logs"
        if (git diff --cached --name-only) {
            # No git identity on this PC: fall back to the last commit's author so commit doesn't fail.
            $idArgs = @()
            if (-not (git config user.email)) {
                $idArgs = @("-c", "user.name=$(git log -1 --format=%an)", "-c", "user.email=$(git log -1 --format=%ae)")
            }
            $msgFile = Join-Path $runDir "commit-msg.txt"
            "$($t.area): $($t.name)`n`n$($t.task)`n`n$($res.result)" | Set-Content $msgFile -Encoding utf8
            $out = git @idArgs commit -q -F $msgFile 2>&1
            if ($LASTEXITCODE -ne 0) {
                Log "COMMIT FAILED: $out"
                $t.done = $false; Save-Plan   # so a rerun picks this task up again
                $ErrorActionPreference = "Stop"; break
            }
            Log "Committed."
            if (-not $NoPush) {
                $out = git push 2>&1
                if ($LASTEXITCODE -ne 0) { Log "PUSH FAILED (commit kept locally): $out" } else { Log "Pushed." }
            }
        } else { Log "(nothing to commit)" }
        $ErrorActionPreference = "Stop"
    }
}

Log ("`nDone: {0} task(s), `${1:N2}. Plan: {2}. Logs: {3}" -f $ran, $totalCost, $planPath, $runDir)
