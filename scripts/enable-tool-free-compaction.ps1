param(
    [Parameter(Mandatory = $true)]
    [string] $profilePath
)

# 把 profile 的压缩后端换成 dsh-world-bili 的“只留对话”压缩。
# 和插件里的 src/compactionSwap.ts 做的是同一件事，规则也一样：
#   - 只改恰好一条压缩行；
#   - 先备份（<文件名>.dsh-world.<随机>.bak），再原子替换；
#   - 已经是我们这一行就什么都不做；
#   - 旧包名 dsh-world/compaction（0.8.0 写错的那个）解析不到包，见到就迁移，而不是当“已经换过”。

$ErrorActionPreference = 'Stop'
try {
    $resolvedProfile = (Resolve-Path -LiteralPath $profilePath).Path
    $packagePath = Join-Path $resolvedProfile 'package.json'
    $patchPath = Join-Path $resolvedProfile 'cordis.patch.yml'
    $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
    # 插件改名后依赖名是 dsh-world-bili；老 profile 里可能还写着 dsh-world，两个都认。
    if (-not ($package.dependencies.'dsh-world-bili' -or $package.dependencies.'dsh-world')) {
        throw 'Install the built dsh-world-bili package in this profile before enabling its compaction backend.'
    }
    $ours = 'dsh-world-bili/compaction'
    $content = [System.IO.File]::ReadAllText($patchPath)
    if ($content -match "(?m)^\s*name:\s*['""]?$([regex]::Escape($ours))['""]?\s*$") {
        Write-Output 'Tool-free compaction is already configured.'
        return
    }
    $stockPattern = "(?m)^(\s*name:\s*)(['""]?)@deepseek-ai/dsh-compaction-basic\2([ \t]*(?:#.*)?\r?)$"
    $legacyPattern = "(?m)^(\s*name:\s*)(['""]?)dsh-world/compaction\2([ \t]*(?:#.*)?\r?)$"
    $updated = $null
    if ([regex]::IsMatch($content, $legacyPattern)) {
        # 旧包名的行已经是“我们的压缩”，只是包名不对：只改名，引号风格保持原样。
        $updated = [regex]::Replace($content, $legacyPattern, "`${1}'$ours'`${3}")
    } else {
        $found = [regex]::Matches($content, $stockPattern)
        if ($found.Count -ne 1) {
            throw "Expected exactly one explicit compaction-basic entry in cordis.patch.yml; found $($found.Count). No configuration was changed."
        }
        $updated = [regex]::Replace($content, $stockPattern, "`${1}'$ours'`${3}")
    }
    $backupPath = "$patchPath.dsh-world.$([Guid]::NewGuid().ToString('N')).bak"
    $temporaryPath = "$patchPath.$([Guid]::NewGuid().ToString('N')).tmp"
    [System.IO.File]::WriteAllText($temporaryPath, $updated, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::Replace($temporaryPath, $patchPath, $backupPath)
    Write-Output "Configured tool-free compaction. Restart this DSH profile to load it. Backup: $backupPath"
} catch {
    throw "Cannot configure dsh-world compaction: $($_.Exception.Message)"
}
