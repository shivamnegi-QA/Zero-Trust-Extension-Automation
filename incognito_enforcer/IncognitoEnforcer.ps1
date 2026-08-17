
$EventLogSource = "SquareX Enterprise Incognito Enforcer"
$EventLogName = "Application"

# Error handling function
function Write-ErrorAndExit {
    param($ErrorMessage, $ErrorRecord)
    $fullMessage = "$ErrorMessage`nDetails: $($ErrorRecord.Exception.Message)"
    Write-EventLog -LogName $EventLogName -Source $EventLogSource -EntryType Error -EventId 1001 -Message $fullMessage
    Write-Error $fullMessage
    exit 1
}

# Initialize logging
try {
    if (-not ([System.Diagnostics.EventLog]::SourceExists($EventLogSource))) {
        New-EventLog -LogName $EventLogName -Source $EventLogSource
        Write-EventLog -LogName $EventLogName -Source $EventLogSource -EntryType Information -EventId 1000 -Message "Event log source created"
    }
} catch {
    Write-Error "Failed to create event log source: $($_.Exception.Message)"
    exit 1
}




function EnforceInIncognito {
    try {
        # Define the incognito enforcer script content as a here-string
        $incognitoEnforcerScript = @'
# IncognitoEnforcer.ps1 - Windows version

param(
    [switch]$Disable,
    [switch]$Debug
)


$EventLogSource = "SquareX Enterprise Incognito Enforcer"
$EventLogName = "Application"
$EventIdInfo = 1000
$EventIdError = 1001
$EventIdWarning = 1002
$EventIdDebug = 1003

$ErrorActionPreference = "Stop"
$extensionID = "kpgdheeifhfpkehmcmafbnmlgnlndgph"

if (-not ([System.Diagnostics.EventLog]::SourceExists($EventLogSource))) {
    $EventLogSource = "Application"
}

function Write-EventLogEntry {
    param(
        [string]$Message,
        [ValidateSet("Information", "Warning", "Error")]
        [string]$EntryType = "Information",
        [int]$EventId = 0
    )
    if ([string]::IsNullOrWhiteSpace($Message)) {
        return
    }
    if ($EventId -le 0) {
        switch ($EntryType) {
            "Error" { $EventId = $EventIdError }
            "Warning" { $EventId = $EventIdWarning }
            default { $EventId = $EventIdInfo }
        }
    }
    Write-EventLog -LogName $EventLogName -Source $EventLogSource -EventId $EventId -EntryType $EntryType -Message $Message
    if ($EntryType -eq "Information") {
        Write-Host $Message -ForegroundColor Green
    } 
}

# Fixed Chrome seed (64 bytes)
$chromeSeedBytes = @(
    0xe7, 0x48, 0xf3, 0x36, 0xd8, 0x5e, 0xa5, 0xf9,
    0xdc, 0xdf, 0x25, 0xd8, 0xf3, 0x47, 0xa6, 0x5b,
    0x4c, 0xdf, 0x66, 0x76, 0x00, 0xf0, 0x2d, 0xf6,
    0x72, 0x4a, 0x2a, 0xf1, 0x8a, 0x21, 0x2d, 0x26,
    0xb7, 0x88, 0xa2, 0x50, 0x86, 0x91, 0x0c, 0xf3,
    0xa9, 0x03, 0x13, 0x69, 0x68, 0x71, 0xf3, 0xdc,
    0x05, 0x82, 0x37, 0x30, 0xc9, 0x1d, 0xf8, 0xba,
    0x5c, 0x4f, 0xd9, 0xc8, 0x84, 0xb5, 0x05, 0xa8
)
$chromeSeed = [byte[]]$chromeSeedBytes

# Empty seed for Edge/Brave/etc
$emptySeed = [byte[]]@()

function Write-DebugLog {
    param([string]$Message)
    return
}

function Get-SeedForBrowser {
    param([string]$BrowserName)
    if ($BrowserName -eq "Chrome") {
        return $chromeSeed
    }
    return $emptySeed
}

function Protect-Value {
    param($Value)
    if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
        Write-Output -NoEnumerate $Value
        return
    }
    return $Value
}

#region JSON Parsing with Order Preservation
# Custom JSON parser that preserves key order using [ordered] hashtables

function New-JsonNumber {
    param([string]$Raw)
    return [pscustomobject]@{ __jsonNumber = $Raw }
}

function Is-JsonNumber {
    param($Value)
    return ($Value -is [pscustomobject]) -and ($Value.PSObject.Properties.Name -contains "__jsonNumber")
}

function Convert-EntriesToOrderedDictionary {
    param($Value)

    if ($Value -is [System.Collections.IDictionary]) {
        Write-Output -NoEnumerate $Value
        return
    }
    if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
        $dict = New-Object System.Collections.Specialized.OrderedDictionary
        $hasEntries = $false
        foreach ($item in $Value) {
            if ($item -is [System.Collections.DictionaryEntry]) {
                $dict[$item.Key] = $item.Value
                $hasEntries = $true
                continue
            }
            $props = $item.PSObject.Properties.Name
            if ($props -contains "Key" -and $props -contains "Value") {
                $dict[$item.Key] = $item.Value
                $hasEntries = $true
                continue
            }
            $hasEntries = $false
            break
        }
        if ($hasEntries) {
            Write-Output -NoEnumerate $dict
            return
        }
    }
    return $Value
}

# JSON parsing helper functions (top-level to avoid nested function output stream issues)
function Skip-JsonWhitespace {
    param([byte[]]$Bytes, [ref]$Idx)
    while ($Idx.Value -lt $Bytes.Length) {
        $ch = $Bytes[$Idx.Value]
        if ($ch -eq 0x20 -or $ch -eq 0x0A -or $ch -eq 0x0D -or $ch -eq 0x09) {
            $Idx.Value++
        } else {
            break
        }
    }
}

function Read-JsonUtf8Char {
    param([byte[]]$Bytes, [ref]$Idx)
    $b0 = $Bytes[$Idx.Value]
    if ($b0 -lt 0x80) {
        $Idx.Value++
        return [char]$b0
    }
    $len = 0
    if (($b0 -band 0xE0) -eq 0xC0) { $len = 2 }
    elseif (($b0 -band 0xF0) -eq 0xE0) { $len = 3 }
    elseif (($b0 -band 0xF8) -eq 0xF0) { $len = 4 }
    else { throw "Invalid UTF-8 leading byte" }
    if ($Idx.Value + $len -gt $Bytes.Length) { throw "Invalid UTF-8 length" }
    $ch = [System.Text.Encoding]::UTF8.GetString($Bytes, $Idx.Value, $len)
    $Idx.Value += $len
    return $ch
}

function Read-JsonHex4 {
    param([byte[]]$Bytes, [ref]$Idx)
    if ($Idx.Value + 4 -gt $Bytes.Length) { throw "Invalid unicode escape" }
    $value = 0
    for ($i = 0; $i -lt 4; $i++) {
        $ch = $Bytes[$Idx.Value]
        $Idx.Value++
        $digit = 0
        if ($ch -ge 0x30 -and $ch -le 0x39) { $digit = $ch - 0x30 }
        elseif ($ch -ge 0x41 -and $ch -le 0x46) { $digit = $ch - 0x41 + 10 }
        elseif ($ch -ge 0x61 -and $ch -le 0x66) { $digit = $ch - 0x61 + 10 }
        else { throw "Invalid unicode escape" }
        $value = ($value -shl 4) + $digit
    }
    return $value
}

function Read-JsonString {
    param([byte[]]$Bytes, [ref]$Idx)
    if ($Bytes[$Idx.Value] -ne 0x22) { throw "Invalid string" }
    $Idx.Value++
    $sb = New-Object System.Text.StringBuilder
    while ($Idx.Value -lt $Bytes.Length) {
        $ch = $Bytes[$Idx.Value]
        if ($ch -eq 0x22) {
            $Idx.Value++
            break
        }
        if ($ch -eq 0x5C) {
            $Idx.Value++
            if ($Idx.Value -ge $Bytes.Length) { throw "Invalid escape" }
            $esc = $Bytes[$Idx.Value]
            $Idx.Value++
            switch ($esc) {
                0x22 { [void]$sb.Append('"') }
                0x5C { [void]$sb.Append('\') }
                0x2F { [void]$sb.Append('/') }
                0x62 { [void]$sb.Append([char]0x08) }
                0x66 { [void]$sb.Append([char]0x0C) }
                0x6E { [void]$sb.Append([char]0x0A) }
                0x72 { [void]$sb.Append([char]0x0D) }
                0x74 { [void]$sb.Append([char]0x09) }
                0x75 {
                    $high = Read-JsonHex4 -Bytes $Bytes -Idx $Idx
                    if ($high -ge 0xD800 -and $high -le 0xDBFF) {
                        $saved = $Idx.Value
                        if ($Idx.Value + 2 -le $Bytes.Length -and $Bytes[$Idx.Value] -eq 0x5C -and $Bytes[$Idx.Value + 1] -eq 0x75) {
                            $Idx.Value += 2
                            $low = Read-JsonHex4 -Bytes $Bytes -Idx $Idx
                            if ($low -ge 0xDC00 -and $low -le 0xDFFF) {
                                $codepoint = 0x10000 + (($high - 0xD800) -shl 10) + ($low - 0xDC00)
                                [void]$sb.Append([System.Char]::ConvertFromUtf32($codepoint))
                                continue
                            }
                        }
                        $Idx.Value = $saved
                    }
                    [void]$sb.Append([System.Char]::ConvertFromUtf32($high))
                }
                default { throw "Invalid escape" }
            }
            continue
        }
        [void]$sb.Append((Read-JsonUtf8Char -Bytes $Bytes -Idx $Idx))
    }
    return $sb.ToString()
}

function Read-JsonNumber {
    param([byte[]]$Bytes, [ref]$Idx)
    $start = $Idx.Value
    if ($Bytes[$Idx.Value] -eq 0x2D) { $Idx.Value++ }
    if ($Idx.Value -ge $Bytes.Length) { throw "Invalid number" }
    $ch = $Bytes[$Idx.Value]
    if ($ch -eq 0x30) {
        $Idx.Value++
    } elseif ($ch -ge 0x31 -and $ch -le 0x39) {
        $Idx.Value++
        while ($Idx.Value -lt $Bytes.Length) {
            $d = $Bytes[$Idx.Value]
            if ($d -ge 0x30 -and $d -le 0x39) { $Idx.Value++ } else { break }
        }
    } else {
        throw "Invalid number"
    }
    if ($Idx.Value -lt $Bytes.Length -and $Bytes[$Idx.Value] -eq 0x2E) {
        $Idx.Value++
        if ($Idx.Value -ge $Bytes.Length) { throw "Invalid number" }
        $d = $Bytes[$Idx.Value]
        if ($d -lt 0x30 -or $d -gt 0x39) { throw "Invalid number" }
        while ($Idx.Value -lt $Bytes.Length) {
            $d = $Bytes[$Idx.Value]
            if ($d -ge 0x30 -and $d -le 0x39) { $Idx.Value++ } else { break }
        }
    }
    if ($Idx.Value -lt $Bytes.Length) {
        $e = $Bytes[$Idx.Value]
        if ($e -eq 0x65 -or $e -eq 0x45) {
            $Idx.Value++
            if ($Idx.Value -lt $Bytes.Length) {
                $sign = $Bytes[$Idx.Value]
                if ($sign -eq 0x2B -or $sign -eq 0x2D) { $Idx.Value++ }
            }
            if ($Idx.Value -ge $Bytes.Length) { throw "Invalid number" }
            $d = $Bytes[$Idx.Value]
            if ($d -lt 0x30 -or $d -gt 0x39) { throw "Invalid number" }
            while ($Idx.Value -lt $Bytes.Length) {
                $d = $Bytes[$Idx.Value]
                if ($d -ge 0x30 -and $d -le 0x39) { $Idx.Value++ } else { break }
            }
        }
    }
    $raw = [System.Text.Encoding]::ASCII.GetString($Bytes, $start, $Idx.Value - $start)
    return (New-JsonNumber -Raw $raw)
}

function Read-JsonValue {
    param([byte[]]$Bytes, [ref]$Idx)
    Skip-JsonWhitespace -Bytes $Bytes -Idx $Idx
    if ($Idx.Value -ge $Bytes.Length) { throw "Unexpected end" }
    $ch = $Bytes[$Idx.Value]
    switch ($ch) {
        0x7B {
            $obj = Read-JsonObject -Bytes $Bytes -Idx $Idx
            Write-Output -NoEnumerate $obj
            return
        }
        0x5B {
            $arr = Read-JsonArray -Bytes $Bytes -Idx $Idx
            Write-Output -NoEnumerate $arr
            return
        }
        0x22 { return (Read-JsonString -Bytes $Bytes -Idx $Idx) }
        0x74 {
            if ($Idx.Value + 4 -gt $Bytes.Length) { throw "Invalid token" }
            if ([System.Text.Encoding]::ASCII.GetString($Bytes, $Idx.Value, 4) -ne "true") { throw "Invalid token" }
            $Idx.Value += 4
            return $true
        }
        0x66 {
            if ($Idx.Value + 5 -gt $Bytes.Length) { throw "Invalid token" }
            if ([System.Text.Encoding]::ASCII.GetString($Bytes, $Idx.Value, 5) -ne "false") { throw "Invalid token" }
            $Idx.Value += 5
            return $false
        }
        0x6E {
            if ($Idx.Value + 4 -gt $Bytes.Length) { throw "Invalid token" }
            if ([System.Text.Encoding]::ASCII.GetString($Bytes, $Idx.Value, 4) -ne "null") { throw "Invalid token" }
            $Idx.Value += 4
            return $null
        }
        0x2D { return (Read-JsonNumber -Bytes $Bytes -Idx $Idx) }
        default {
            if ($ch -ge 0x30 -and $ch -le 0x39) { return (Read-JsonNumber -Bytes $Bytes -Idx $Idx) }
            throw "Invalid token"
        }
    }
}

function Read-JsonObject {
    param([byte[]]$Bytes, [ref]$Idx)
    if ($Bytes[$Idx.Value] -ne 0x7B) { throw "Invalid object" }
    $Idx.Value++
    Skip-JsonWhitespace -Bytes $Bytes -Idx $Idx
    $dict = New-Object System.Collections.Specialized.OrderedDictionary
    if ($Idx.Value -lt $Bytes.Length -and $Bytes[$Idx.Value] -eq 0x7D) {
        $Idx.Value++
        Write-Output -NoEnumerate $dict
        return
    }
    while ($Idx.Value -lt $Bytes.Length) {
        Skip-JsonWhitespace -Bytes $Bytes -Idx $Idx
        $key = Read-JsonString -Bytes $Bytes -Idx $Idx
        Skip-JsonWhitespace -Bytes $Bytes -Idx $Idx
        if ($Idx.Value -ge $Bytes.Length -or $Bytes[$Idx.Value] -ne 0x3A) { throw "Invalid object" }
        $Idx.Value++
        $value = Read-JsonValue -Bytes $Bytes -Idx $Idx
        $dict.Add($key, $value)
        Skip-JsonWhitespace -Bytes $Bytes -Idx $Idx
        if ($Idx.Value -ge $Bytes.Length) { throw "Invalid object" }
        $next = $Bytes[$Idx.Value]
        if ($next -eq 0x2C) {
            $Idx.Value++
            continue
        }
        if ($next -eq 0x7D) {
            $Idx.Value++
            break
        }
        throw "Invalid object"
    }
    Write-Output -NoEnumerate $dict
    return
}

function Read-JsonArray {
    param([byte[]]$Bytes, [ref]$Idx)
    if ($Bytes[$Idx.Value] -ne 0x5B) { throw "Invalid array" }
    $Idx.Value++
    Skip-JsonWhitespace -Bytes $Bytes -Idx $Idx
    $arr = @()
    if ($Idx.Value -lt $Bytes.Length -and $Bytes[$Idx.Value] -eq 0x5D) {
        $Idx.Value++
        Write-Output -NoEnumerate $arr
        return
    }
    while ($Idx.Value -lt $Bytes.Length) {
        $item = Read-JsonValue -Bytes $Bytes -Idx $Idx
        $arr += ,$item
        Skip-JsonWhitespace -Bytes $Bytes -Idx $Idx
        if ($Idx.Value -ge $Bytes.Length) { throw "Invalid array" }
        $next = $Bytes[$Idx.Value]
        if ($next -eq 0x2C) {
            $Idx.Value++
            continue
        }
        if ($next -eq 0x5D) {
            $Idx.Value++
            break
        }
        throw "Invalid array"
    }
    Write-Output -NoEnumerate $arr
    return
}

function Parse-JsonBytes {
    param([byte[]]$Data)
    $idx = 0
    $value = Read-JsonValue -Bytes $Data -Idx ([ref]$idx)
    Skip-JsonWhitespace -Bytes $Data -Idx ([ref]$idx)
    if ($idx -ne $Data.Length) { throw "Trailing characters" }
    Write-Output -NoEnumerate $value
    return
}

function Read-JsonFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
        $text = [System.Text.Encoding]::Unicode.GetString($bytes)
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF) {
        $text = [System.Text.Encoding]::BigEndianUnicode.GetString($bytes)
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    } elseif ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        $bytes = $bytes[3..($bytes.Length - 1)]
    }
    try {
        $parsed = Parse-JsonBytes -Data $bytes
        $parsed = Convert-EntriesToOrderedDictionary -Value $parsed
        Protect-Value -Value $parsed
        return
    } catch {
        Write-DebugLog ("debug parse: failed to parse '{0}': {1}" -f $Path, $_.Exception.Message)
        return $null
    }
}

function Parse-JsonOrdered {
    param([string]$JsonString)
    if ($null -eq $JsonString) { return $null }
    if ($JsonString.Length -gt 0 -and $JsonString[0] -eq [char]0xFEFF) {
        $JsonString = $JsonString.Substring(1)
    }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($JsonString)
    return Parse-JsonBytes -Data $bytes
}
#endregion

#region JSON Serialization (compact, no spaces)
function Escape-JsonString {
    param([string]$Value)

    $sb = New-Object System.Text.StringBuilder
    foreach ($ch in $Value.ToCharArray()) {
        $code = [int][char]$ch
        switch ($code) {
            34 { [void]$sb.Append('\"') }
            92 { [void]$sb.Append('\\') }
            8  { [void]$sb.Append('\b') }
            12 { [void]$sb.Append('\f') }
            10 { [void]$sb.Append('\n') }
            13 { [void]$sb.Append('\r') }
            9  { [void]$sb.Append('\t') }
            default {
                if ($code -lt 0x20) {
                    [void]$sb.Append(("{0}\u{1:x4}" -f '\', $code))
                } else {
                    [void]$sb.Append($ch)
                }
            }
        }
    }
    return $sb.ToString()
}

function ConvertTo-JsonCompact {
    param($Value)

    if ($null -eq $Value) { return "null" }
    if (Is-JsonNumber $Value) { return $Value.__jsonNumber }
    if ($Value -is [byte] -or $Value -is [sbyte] -or $Value -is [int16] -or $Value -is [uint16] -or
        $Value -is [int] -or $Value -is [uint32] -or $Value -is [long] -or $Value -is [uint64] -or
        $Value -is [single] -or $Value -is [double] -or $Value -is [decimal] -or
        $Value -is [System.Numerics.BigInteger]) {
        $culture = [System.Globalization.CultureInfo]::InvariantCulture
        if ($Value -is [single] -or $Value -is [double]) {
            return $Value.ToString("R", $culture)
        }
        return $Value.ToString($culture)
    }
    if ($Value -is [System.Collections.Specialized.OrderedDictionary]) {
        $parts = @()
        foreach ($key in $Value.Keys) {
            $parts += '"' + (Escape-JsonString -Value $key) + '":' + (ConvertTo-JsonCompact -Value $Value[$key])
        }
        return "{" + ($parts -join ",") + "}"
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $parts = @()
        foreach ($key in $Value.Keys) {
            $parts += '"' + (Escape-JsonString -Value $key) + '":' + (ConvertTo-JsonCompact -Value $Value[$key])
        }
        return "{" + ($parts -join ",") + "}"
    }
    if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
        $parts = @()
        foreach ($item in $Value) {
            $parts += (ConvertTo-JsonCompact -Value $item)
        }
        return "[" + ($parts -join ",") + "]"
    }
    if ($Value -is [bool]) {
        return ($Value.ToString().ToLower())
    }
    if ($Value -is [string]) {
        return '"' + (Escape-JsonString -Value $Value) + '"'
    }
    return '"' + (Escape-JsonString -Value $Value.ToString()) + '"'
}
#endregion

#region removeEmpty - mirrors utils.py removeEmpty
function Remove-Empty {
    param([ref]$Value)
    if ($Value.Value -is [System.Collections.IDictionary]) {
        $keys = @($Value.Value.Keys)
        foreach ($key in $keys) {
            $child = $Value.Value[$key]
            if ($child -is [System.Collections.IDictionary] -or ($child -is [System.Collections.IEnumerable] -and -not ($child -is [string]))) {
                $ref = [ref]$child
                Remove-Empty -Value $ref
                $child = $ref.Value
                $Value.Value[$key] = $child
            }
            if ($null -eq $child) {
                $Value.Value.Remove($key)
                continue
            }
            if ($child -is [string] -and $child.Length -eq 0) {
                $Value.Value.Remove($key)
                continue
            }
            if ($child -is [System.Collections.IDictionary] -and $child.Count -eq 0) {
                $Value.Value.Remove($key)
                continue
            }
            if ($child -is [System.Collections.IEnumerable] -and -not ($child -is [string])) {
                if (($child | Measure-Object).Count -eq 0) {
                    $Value.Value.Remove($key)
                }
            }
        }
    } elseif ($Value.Value -is [System.Collections.IEnumerable] -and -not ($Value.Value -is [string])) {
        $newItems = @()
        foreach ($item in $Value.Value) {
            $child = $item
            if ($child -is [System.Collections.IDictionary] -or ($child -is [System.Collections.IEnumerable] -and -not ($child -is [string]))) {
                $ref = [ref]$child
                Remove-Empty -Value $ref
                $child = $ref.Value
            }
            if ($null -eq $child) { continue }
            if ($child -is [string] -and $child.Length -eq 0) { continue }
            if ($child -is [System.Collections.IDictionary] -and $child.Count -eq 0) { continue }
            if ($child -is [System.Collections.IEnumerable] -and -not ($child -is [string])) {
                if (($child | Measure-Object).Count -eq 0) { continue }
            }
            if (-not $child -and $child -ne $false -and $child -ne 0) { continue }
            $newItems += ,$child
        }
        $Value.Value = $newItems
    }
}
#endregion

#region Deep Clone
function Copy-DeepClone {
    param($Value)

    if ($null -eq $Value) {
        return $null
    }

    if ($Value -is [System.Collections.IDictionary]) {
        $clone = [ordered]@{}
        foreach ($key in $Value.Keys) {
            $clone[$key] = Copy-DeepClone $Value[$key]
        }
        Write-Output -NoEnumerate $clone
        return
    }

    # Check array before string (strings are enumerable)
    if ($Value -is [array] -and $Value -isnot [string]) {
        $clone = [System.Collections.Generic.List[object]]::new()
        foreach ($item in $Value) {
            $clone.Add((Copy-DeepClone $item)) | Out-Null
        }
        # Comma operator prevents single-element unwrapping
        return ,$clone.ToArray()
    }

    return $Value
}
#endregion

#region Clean JSON Variants
function Get-CleanJsonVariants {
    param($Value)

    $cleanedValue = Copy-DeepClone $Value
    if ($cleanedValue -is [System.Collections.IDictionary]) {
        $ref = [ref]$cleanedValue
        Remove-Empty -Value $ref
        $cleanedValue = $ref.Value
    }

    $jsonValue = ConvertTo-JsonCompact $cleanedValue
    $jsonValue = $jsonValue.Replace("<", "\u003C")

    $trademarkSymbol = [char]0x2122
    $hmacJson = $jsonValue.Replace("\u2122", $trademarkSymbol)

    return [pscustomobject]@{
        HmacJson = $hmacJson
        EncryptedJson = $jsonValue
    }
}
#endregion

#region HMAC Calculation - mirrors utils.py calculateHMAC
function Calculate-HMAC {
    param(
        $Value,
        [string]$Path,
        [string]$SID,
        [byte[]]$Seed,
        [string]$JsonValue
    )

    if ([string]::IsNullOrEmpty($JsonValue)) {
        $variants = Get-CleanJsonVariants -Value $Value
        $jsonValue = $variants.HmacJson
    } else {
        $jsonValue = $JsonValue
    }

    # Build message: sid + path + json
    $message = $SID + $Path + $jsonValue

    Write-DebugLog "Path: $Path"
    Write-DebugLog "SID: $SID"
    Write-DebugLog "JSON length: $($jsonValue.Length)"
    Write-DebugLog "Message length: $($message.Length)"
    Write-DebugLog "JSON sample: $($jsonValue.Substring(0, [Math]::Min(100, $jsonValue.Length)))..."

    # Compute HMAC-SHA256
    $messageBytes = [System.Text.Encoding]::UTF8.GetBytes($message)
    $hmac = New-Object System.Security.Cryptography.HMACSHA256
    # .NET HMAC requires non-empty key; empty seed = 64 zero bytes (SHA256 block size)
    if ($null -eq $Seed -or $Seed.Length -eq 0) {
        $hmac.Key = New-Object byte[] 64
    } else {
        $hmac.Key = $Seed
    }
    $hashBytes = $hmac.ComputeHash($messageBytes)

    # Return uppercase hex
    $result = ($hashBytes | ForEach-Object { $_.ToString("X2") }) -join ""

    Write-DebugLog "Calculated MAC: $result"

    return $result
}
#endregion

#region Encrypted Hash - mirrors main.swift encryptedHash
# AES-GCM encryption using Windows BCrypt API (for PowerShell 5.1 compatibility)
function Invoke-AesGcmEncrypt {
    param(
        [byte[]]$Key,
        [byte[]]$Nonce,
        [byte[]]$Plaintext
    )

    # Add BCrypt P/Invoke definitions if not already loaded
    if (-not ([System.Management.Automation.PSTypeName]'BCryptAesGcm').Type) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class BCryptAesGcm {
    [DllImport("bcrypt.dll")]
    public static extern uint BCryptOpenAlgorithmProvider(
        out IntPtr phAlgorithm,
        [MarshalAs(UnmanagedType.LPWStr)] string pszAlgId,
        [MarshalAs(UnmanagedType.LPWStr)] string pszImplementation,
        uint dwFlags);

    [DllImport("bcrypt.dll")]
    public static extern uint BCryptSetProperty(
        IntPtr hObject,
        [MarshalAs(UnmanagedType.LPWStr)] string pszProperty,
        byte[] pbInput,
        uint cbInput,
        uint dwFlags);

    [DllImport("bcrypt.dll")]
    public static extern uint BCryptGenerateSymmetricKey(
        IntPtr hAlgorithm,
        out IntPtr phKey,
        IntPtr pbKeyObject,
        uint cbKeyObject,
        byte[] pbSecret,
        uint cbSecret,
        uint dwFlags);

    [DllImport("bcrypt.dll")]
    public static extern uint BCryptEncrypt(
        IntPtr hKey,
        byte[] pbInput,
        uint cbInput,
        IntPtr pPaddingInfo,
        byte[] pbIV,
        uint cbIV,
        byte[] pbOutput,
        uint cbOutput,
        out uint pcbResult,
        uint dwFlags);

    [DllImport("bcrypt.dll")]
    public static extern uint BCryptDestroyKey(IntPtr hKey);

    [DllImport("bcrypt.dll")]
    public static extern uint BCryptCloseAlgorithmProvider(IntPtr hAlgorithm, uint dwFlags);

    [StructLayout(LayoutKind.Sequential)]
    public struct BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO {
        public uint cbSize;
        public uint dwInfoVersion;
        public IntPtr pbNonce;
        public uint cbNonce;
        public IntPtr pbAuthData;
        public uint cbAuthData;
        public IntPtr pbTag;
        public uint cbTag;
        public IntPtr pbMacContext;
        public uint cbMacContext;
        public uint cbAAD;
        public ulong cbData;
        public uint dwFlags;
    }

    public const string BCRYPT_AES_ALGORITHM = "AES";
    public const string BCRYPT_CHAINING_MODE = "ChainingMode";
    public const string BCRYPT_CHAIN_MODE_GCM = "ChainingModeGCM";
    public const uint BCRYPT_AUTH_MODE_INFO_VERSION = 1;

    public static byte[] Encrypt(byte[] key, byte[] nonce, byte[] plaintext, out byte[] tag) {
        IntPtr hAlgorithm = IntPtr.Zero;
        IntPtr hKey = IntPtr.Zero;
        tag = new byte[16];

        try {
            uint status = BCryptOpenAlgorithmProvider(out hAlgorithm, BCRYPT_AES_ALGORITHM, null, 0);
            if (status != 0) throw new Exception("BCryptOpenAlgorithmProvider failed: " + status);

            byte[] chainMode = System.Text.Encoding.Unicode.GetBytes(BCRYPT_CHAIN_MODE_GCM + "\0");
            status = BCryptSetProperty(hAlgorithm, BCRYPT_CHAINING_MODE, chainMode, (uint)chainMode.Length, 0);
            if (status != 0) throw new Exception("BCryptSetProperty failed: " + status);

            status = BCryptGenerateSymmetricKey(hAlgorithm, out hKey, IntPtr.Zero, 0, key, (uint)key.Length, 0);
            if (status != 0) throw new Exception("BCryptGenerateSymmetricKey failed: " + status);

            byte[] ciphertext = new byte[plaintext.Length];
            byte[] iv = new byte[nonce.Length];
            Array.Copy(nonce, iv, nonce.Length);

            GCHandle nonceHandle = GCHandle.Alloc(nonce, GCHandleType.Pinned);
            GCHandle tagHandle = GCHandle.Alloc(tag, GCHandleType.Pinned);

            try {
                BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO authInfo = new BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO();
                authInfo.cbSize = (uint)Marshal.SizeOf(typeof(BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO));
                authInfo.dwInfoVersion = BCRYPT_AUTH_MODE_INFO_VERSION;
                authInfo.pbNonce = nonceHandle.AddrOfPinnedObject();
                authInfo.cbNonce = (uint)nonce.Length;
                authInfo.pbTag = tagHandle.AddrOfPinnedObject();
                authInfo.cbTag = (uint)tag.Length;

                IntPtr authInfoPtr = Marshal.AllocHGlobal(Marshal.SizeOf(authInfo));
                Marshal.StructureToPtr(authInfo, authInfoPtr, false);

                try {
                    uint cbResult;
                    status = BCryptEncrypt(hKey, plaintext, (uint)plaintext.Length, authInfoPtr,
                        iv, (uint)iv.Length, ciphertext, (uint)ciphertext.Length, out cbResult, 0);
                    if (status != 0) throw new Exception("BCryptEncrypt failed: " + status);
                } finally {
                    Marshal.FreeHGlobal(authInfoPtr);
                }
            } finally {
                nonceHandle.Free();
                tagHandle.Free();
            }

            return ciphertext;
        } finally {
            if (hKey != IntPtr.Zero) BCryptDestroyKey(hKey);
            if (hAlgorithm != IntPtr.Zero) BCryptCloseAlgorithmProvider(hAlgorithm, 0);
        }
    }
}
"@
    }

    $tag = $null
    $ciphertext = [BCryptAesGcm]::Encrypt($Key, $Nonce, $Plaintext, [ref]$tag)
    return @{ Ciphertext = $ciphertext; Tag = $tag }
}

function Calculate-EncryptedHash {
    param(
        [byte[]]$Seed,
        [string]$Path,
        $Value,
        [byte[]]$EncryptionKey,
        [string]$JsonValue
    )

    if ([string]::IsNullOrEmpty($JsonValue)) {
        $variants = Get-CleanJsonVariants -Value $Value
        $jsonValue = $variants.EncryptedJson
    } else {
        $jsonValue = $JsonValue
    }

    # Build message: seed + path + jsonValue
    $messageBytes = New-Object System.Collections.Generic.List[byte]
    if ($null -ne $Seed -and $Seed.Length -gt 0) {
        $messageBytes.AddRange($Seed)
    }
    $messageBytes.AddRange([System.Text.Encoding]::UTF8.GetBytes($Path))
    $messageBytes.AddRange([System.Text.Encoding]::UTF8.GetBytes($jsonValue))

    # SHA256 hash
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    $hashData = $sha256.ComputeHash($messageBytes.ToArray())
    $hashHex = ($hashData | ForEach-Object { $_.ToString("X2") }) -join ""
    Write-DebugLog "Encrypted hash sha256: $hashHex"

    # v10 format: AES-256-GCM with 12-byte nonce and 16-byte auth tag
    $nonce = New-Object byte[] 12
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($nonce)

    $gcmResult = Invoke-AesGcmEncrypt -Key $EncryptionKey -Nonce $nonce -Plaintext $hashData

    # Build payload: "v10" + nonce + ciphertext + tag
    $payload = New-Object System.Collections.Generic.List[byte]
    $payload.AddRange([System.Text.Encoding]::UTF8.GetBytes("v10"))
    $payload.AddRange($nonce)
    $payload.AddRange($gcmResult.Ciphertext)
    $payload.AddRange($gcmResult.Tag)

    $result = [Convert]::ToBase64String($payload.ToArray())
    Write-DebugLog "Encrypted hash (v10): $result"
    return $result
}
#endregion

#region Super MAC - mirrors main.swift superMac
function Calculate-SuperMac {
    param(
        $Macs,
        [string]$SID,
        [byte[]]$Seed
    )

    $cleanedMacs = Copy-DeepClone $Macs
    if ($cleanedMacs -is [System.Collections.IDictionary]) {
        $ref = [ref]$cleanedMacs
        Remove-Empty -Value $ref
        $cleanedMacs = $ref.Value
    }
    $jsonValue = ConvertTo-JsonCompact $cleanedMacs
    $trademarkSymbol = [char]0x2122
    $jsonValue = $jsonValue.Replace("<", "\u003C").Replace("\u2122", $trademarkSymbol)
    $message = $SID + $jsonValue

    $messageBytes = [System.Text.Encoding]::UTF8.GetBytes($message)
    $hmac = New-Object System.Security.Cryptography.HMACSHA256
    # .NET HMAC requires non-empty key; empty seed = 64 zero bytes (SHA256 block size)
    if ($null -eq $Seed -or $Seed.Length -eq 0) {
        $hmac.Key = New-Object byte[] 64
    } else {
        $hmac.Key = $Seed
    }
    $hashBytes = $hmac.ComputeHash($messageBytes)

    $result = ($hashBytes | ForEach-Object { $_.ToString("X2") }) -join ""

    Write-DebugLog "Super MAC: $result"

    return $result
}
#endregion

#region Get Windows SID
function Get-WindowsSID {
    $sid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
    # Drop the RID segment regardless of length.
    $sid = ($sid -replace "-\d+$", "")

    Write-DebugLog "Windows SID (trimmed): $sid"

    return $sid
}
#endregion

#region Get Value by Path
function Get-ValueByPath {
    param(
        $Data,
        [string[]]$Path
    )

    if ($Path.Count -eq 0) {
        Protect-Value -Value $Data
        return
    }

    $current = Convert-EntriesToOrderedDictionary -Value $Data
    foreach ($key in $Path) {
        if ($null -eq $current) { return $null }
        $current = Convert-EntriesToOrderedDictionary -Value $current
        if ($current -is [System.Collections.IDictionary]) {
            if ($current.Contains($key)) {
                $current = $current[$key]
            } else {
                return $null
            }
        } else {
            return $null
        }
    }
    Protect-Value -Value $current
    return
}
#endregion

#region Set Value by Path
function Set-ValueByPath {
    param(
        $Data,
        [string[]]$Path,
        $NewValue
    )

    if ($Path.Count -eq 0) { return }

    $current = $Data
    for ($i = 0; $i -lt $Path.Count - 1; $i++) {
        $key = $Path[$i]
        if (-not $current.Contains($key)) {
            $current[$key] = [ordered]@{}
        }
        $current = $current[$key]
    }

    $current[$Path[-1]] = $NewValue
}
#endregion

#region Find Seed Test Target
function Find-SeedTestTarget {
    param($Data)

    # Priority 1: pinned_tabs
    $pinnedTabs = Get-ValueByPath $Data @("pinned_tabs")
    $pinnedTabsMac = Get-ValueByPath $Data @("protection", "macs", "pinned_tabs")
    if ($null -ne $pinnedTabs -and $null -ne $pinnedTabsMac -and $pinnedTabsMac -is [string]) {
        Write-DebugLog "Found seed test target: pinned_tabs"
        return @{
            Path = "pinned_tabs"
            Value = $pinnedTabs
            Mac = $pinnedTabsMac
        }
    }

    # Priority 2: browser.show_home_button
    $showHomeButton = Get-ValueByPath $Data @("browser", "show_home_button")
    $showHomeButtonMac = Get-ValueByPath $Data @("protection", "macs", "browser", "show_home_button")
    if ($null -ne $showHomeButton -and $null -ne $showHomeButtonMac -and $showHomeButtonMac -is [string]) {
        Write-DebugLog "Found seed test target: browser.show_home_button"
        return @{
            Path = "browser.show_home_button"
            Value = $showHomeButton
            Mac = $showHomeButtonMac
        }
    }

    # Priority 3: homepage_is_newtabpage
    $homepageIsNewtab = Get-ValueByPath $Data @("homepage_is_newtabpage")
    $homepageIsNewtabMac = Get-ValueByPath $Data @("protection", "macs", "homepage_is_newtabpage")
    if ($null -ne $homepageIsNewtab -and $null -ne $homepageIsNewtabMac -and $homepageIsNewtabMac -is [string]) {
        Write-DebugLog "Found seed test target: homepage_is_newtabpage"
        return @{
            Path = "homepage_is_newtabpage"
            Value = $homepageIsNewtab
            Mac = $homepageIsNewtabMac
        }
    }

    # Fallback: Use any extension settings (matching Swift implementation)
    $settings = Get-ValueByPath $Data @("extensions", "settings")
    $macsSettings = Get-ValueByPath $Data @("protection", "macs", "extensions", "settings")
    if ($null -ne $settings -and $null -ne $macsSettings -and
        $settings -is [System.Collections.IDictionary] -and
        $macsSettings -is [System.Collections.IDictionary]) {
        foreach ($extId in $settings.Keys) {
            if ($macsSettings.Contains($extId)) {
                $macValue = $macsSettings[$extId]
                if ($macValue -is [string]) {
                    Write-DebugLog "Found seed test target: extensions.settings.$extId"
                    return @{
                        Path = "extensions.settings.$extId"
                        Value = $settings[$extId]
                        Mac = $macValue
                    }
                }
            }
        }
    }

    return $null
}
#endregion

#region Insert incognito after granted_permissions
function Insert-IncognitoAfterGrantedPermissions {
    param(
        $Settings,
        [bool]$IncognitoValue
    )

    if ($Settings -isnot [System.Collections.IDictionary]) {
        return $Settings
    }

    $newSettings = [ordered]@{}
    $inserted = $false

    foreach ($key in $Settings.Keys) {
        if ($key -eq "incognito") {
            continue  # Skip existing incognito key
        }
        $newSettings[$key] = $Settings[$key]
        if ($key -eq "granted_permissions") {
            $newSettings["incognito"] = $IncognitoValue
            $inserted = $true
        }
    }

    if (-not $inserted) {
        # Insert before incognito_content_settings if it exists
        $rebuilt = [ordered]@{}
        $insertedAtContentSettings = $false

        foreach ($key in $newSettings.Keys) {
            if ($key -eq "incognito_content_settings" -and -not $insertedAtContentSettings) {
                $rebuilt["incognito"] = $IncognitoValue
                $insertedAtContentSettings = $true
            }
            $rebuilt[$key] = $newSettings[$key]
        }

        if (-not $insertedAtContentSettings) {
            $rebuilt["incognito"] = $IncognitoValue
        }

        Write-Output -NoEnumerate $rebuilt
        return
    }

    Write-Output -NoEnumerate $newSettings
    return
}
#endregion

#region Get Encryption Key from DPAPI
function Get-EncryptionKey {
    param([string]$LocalStatePath)

    if (-not (Test-Path $LocalStatePath)) {
        Write-DebugLog "Local State file not found: $LocalStatePath"
        return $null
    }

    $localState = Get-Content $LocalStatePath -Raw | ConvertFrom-Json
    $encryptedKeyB64 = $localState.os_crypt.encrypted_key

    if ([string]::IsNullOrEmpty($encryptedKeyB64)) {
        Write-DebugLog "No encrypted_key in Local State"
        return $null
    }

    $encryptedKey = [Convert]::FromBase64String($encryptedKeyB64)

    # Remove "DPAPI" prefix (5 bytes)
    if ($encryptedKey.Length -lt 5) {
        Write-DebugLog "Encrypted key too short"
        return $null
    }

    $keyWithoutPrefix = $encryptedKey[5..($encryptedKey.Length - 1)]

    # Decrypt using DPAPI
    Add-Type -AssemblyName System.Security
    $decryptedKey = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $keyWithoutPrefix,
        $null,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )

    Write-DebugLog "Decrypted encryption key: $($decryptedKey.Length) bytes"

    return $decryptedKey
}
#endregion

#region Resources.pak seed extraction
function Find-ResourcesPak {
    param([string]$ResourcesRoot)

    if (-not (Test-Path $ResourcesRoot)) {
        return $null
    }

    # Search for resources.pak or opera.pak
    $files = Get-ChildItem -Path $ResourcesRoot -Recurse -Filter "*.pak" -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq "resources.pak" -or $_.Name -eq "opera.pak" }

    if ($files) {
        return $files[0].FullName
    }

    return $null
}

function Read-UInt16LE {
    param([byte[]]$Data, [int]$Offset)
    # Use BitConverter for reliable byte reading
    return [BitConverter]::ToUInt16($Data, $Offset)
}

function Read-UInt32LE {
    param([byte[]]$Data, [int]$Offset)
    return [BitConverter]::ToUInt32($Data, $Offset)
}

function Get-ResourcesFromPak {
    param([string]$PakPath)

    if (-not (Test-Path $PakPath)) {
        return $null
    }

    $data = [System.IO.File]::ReadAllBytes($PakPath)

    if ($data.Length -lt 12) {
        return $null
    }

    # Check version
    $version = Read-UInt32LE $data 0
    Write-DebugLog "Pak version: $version, file size: $($data.Length)"

    # Version 5 has different header format
    if ($version -eq 5) {
        # V5: version(4) + encoding(1) + padding(3) + resource_count(2) + alias_count(2)
        # Actually, alias_count at offset 8 contains the resource count we need
        $resourceCount = [int](Read-UInt16LE $data 8)
        $headerSize = 12
        $entrySize = 6
    } else {
        # V4 and earlier
        $resourceCount = [int](Read-UInt16LE $data 8)
        $headerSize = 12
        $entrySize = 6
    }

    Write-DebugLog "Pak header: resourceCount=$resourceCount, headerSize=$headerSize, entrySize=$entrySize"
    Write-DebugLog "First 12 bytes: $($data[0..11] | ForEach-Object { '{0:X2}' -f $_ })"

    function Get-EntryAt {
        param([int]$Index)
        $base = $headerSize + ($Index * $entrySize)
        $resourceId = Read-UInt16LE $data $base
        $offset = [int](Read-UInt32LE $data ($base + 2))
        return @{ ResourceId = $resourceId; Offset = $offset }
    }

    if ($resourceCount -le 0) {
        return @()
    }

    $outputs = @()
    $prev = Get-EntryAt 0

    for ($i = 1; $i -le $resourceCount; $i++) {
        $current = Get-EntryAt $i
        if ($prev.Offset -le $current.Offset -and $current.Offset -le $data.Length) {
            $length = $current.Offset - $prev.Offset
            $resourceData = New-Object byte[] $length
            [Array]::Copy($data, $prev.Offset, $resourceData, 0, $length)
            $outputs += ,$resourceData
        }
        $prev = $current
    }

    return $outputs
}

function Get-SeedFromResources {
    param(
        [string]$ResourcesRoot,
        [string]$PrefsPath,
        [string]$SID
    )

    # First parse the prefs file to get test target
    $data = Read-JsonFile -Path $PrefsPath
    if ($null -eq $data) {
        Write-DebugLog "Failed to read prefs for seed extraction: $PrefsPath"
        return $null
    }

    $target = Find-SeedTestTarget $data
    if ($null -eq $target) {
        Write-DebugLog "No seed test target found for seed extraction"
        return $null
    }

    Write-DebugLog "Seed test target: $($target.Path)"
    Write-DebugLog "Expected MAC: $($target.Mac)"

    # Try empty seed first for browsers like Edge
    $emptySeed = [byte[]]@()
    $mac = Calculate-HMAC -Value $target.Value -Path $target.Path -SID $SID -Seed $emptySeed
    if ($mac -eq $target.Mac) {
        Write-DebugLog "Empty seed matches!"
        return $emptySeed
    }

    # Find and parse resources.pak
    $pakPath = Find-ResourcesPak $ResourcesRoot
    if ($null -eq $pakPath) {
        Write-DebugLog "resources.pak not found in $ResourcesRoot"
        return $null
    }

    Write-DebugLog "Found resources.pak: $pakPath"

    $resources = Get-ResourcesFromPak $pakPath
    if ($null -eq $resources -or $resources.Count -eq 0) {
        Write-DebugLog "No resources extracted from pak file"
        return $null
    }

    Write-DebugLog "Extracted $($resources.Count) resources from pak"

    # Try each resource as potential seed (try smaller ones first, they're more likely seeds)
    $triedCount = 0
    $sortedResources = $resources | Sort-Object { $_.Length }

    foreach ($resource in $sortedResources) {
        # Skip very large or empty resources
        if ($resource.Length -eq 0 -or $resource.Length -gt 1024) {
            continue
        }
        $triedCount++
        $mac = Calculate-HMAC -Value $target.Value -Path $target.Path -SID $SID -Seed $resource
        if ($mac -eq $target.Mac) {
            Write-DebugLog "Found matching seed: $($resource.Length) bytes (tried $triedCount resources)"
            return $resource
        }
    }

    Write-DebugLog "Tried $triedCount resources from pak, no match"

    # Try hardcoded Chrome seed as fallback
    $mac = Calculate-HMAC -Value $target.Value -Path $target.Path -SID $SID -Seed $chromeSeed
    if ($mac -eq $target.Mac) {
        Write-DebugLog "Hardcoded Chrome seed matches!"
        return $chromeSeed
    }

    Write-DebugLog "No matching seed found"
    return $null
}
#endregion

#region Browser Configuration
$browsers = @(
    @{
        Name = "Chrome"
        ProcessName = "chrome"
        ProfileRoot = "$env:LOCALAPPDATA\Google\Chrome\User Data"
        LocalState = "$env:LOCALAPPDATA\Google\Chrome\User Data\Local State"
        ResourcesRoot = "$env:ProgramFiles\Google\Chrome\Application"
    },
    @{
        Name = "Edge"
        ProcessName = "msedge"
        ProfileRoot = "$env:LOCALAPPDATA\Microsoft\Edge\User Data"
        LocalState = "$env:LOCALAPPDATA\Microsoft\Edge\User Data\Local State"
        ResourcesRoot = "$env:ProgramFiles\Microsoft\Edge\Application"
    },
    @{
        Name = "Brave"
        ProcessName = "brave"
        ProfileRoot = "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\User Data"
        LocalState = "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\User Data\Local State"
        ResourcesRoot = "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application"
    },
    @{
        Name = "Vivaldi"
        ProcessName = "vivaldi"
        ProfileRoot = "$env:LOCALAPPDATA\Vivaldi\User Data"
        LocalState = "$env:LOCALAPPDATA\Vivaldi\User Data\Local State"
        ResourcesRoot = "$env:LOCALAPPDATA\Vivaldi\Application"
    }
)
#endregion

#region List Profile Directories
function Get-ProfileDirs {
    param([string]$ProfileRoot)

    if (-not (Test-Path $ProfileRoot)) {
        return @()
    }

    $items = Get-ChildItem $ProfileRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq "Default" -or $_.Name -match "^Profile \d+$" }

    $sorted = $items | Sort-Object {
        if ($_.Name -eq "Default") { return -1 }
        if ($_.Name -match "^Profile (\d+)$") { return [int]$Matches[1] }
        return [int]::MaxValue
    }

    $dirs = @()
    foreach ($item in $sorted) {
        $dirs += $item.FullName
    }

    if ($dirs.Count -eq 0) {
        $securePrefs = Join-Path $ProfileRoot "Secure Preferences"
        if (Test-Path $securePrefs) {
            $dirs += $ProfileRoot
        }
    }

    return $dirs
}
#endregion

#region Get Secure Preferences Paths
function Get-SecurePrefsPaths {
    param([string]$ProfileRoot)

    $dirs = Get-ProfileDirs $ProfileRoot
    $paths = @()

    foreach ($dir in $dirs) {
        $securePrefs = Join-Path $dir "Secure Preferences"
        if (Test-Path $securePrefs) {
            $paths += $securePrefs
        }
    }

    return ,$paths
}
#endregion

#region Preferences Path from Secure Preferences
function Get-PreferencesPathFromSecure {
    param([string]$SecurePrefsPath)

    $dir = Split-Path -Parent $SecurePrefsPath
    return (Join-Path $dir "Preferences")
}
#endregion

#region Profiles Needing Update (Parallel)
# Check a single profile - returns result object for aggregation
function Test-ProfileNeedsUpdate {
    param(
        [string]$SecurePrefsPath,
        [string]$ExtensionId,
        [bool]$TargetIncognito
    )

    $result = @{
        SecureUpdate = $null
        PrefUpdate = $null
    }

    # Use built-in ConvertFrom-Json for speed (order doesn't matter for checking)
    try {
        $content = [System.IO.File]::ReadAllText($SecurePrefsPath)
        $data = $content | ConvertFrom-Json
    } catch {
        return $result
    }

    # Check Secure Preferences
    $extSettings = $data.extensions.settings
    if ($null -ne $extSettings -and $null -ne $extSettings.$ExtensionId) {
        $settings = $extSettings.$ExtensionId
        $currentIncognito = $settings.incognito

        $needsUpdate = $false
        if ($null -eq $currentIncognito) {
            $needsUpdate = $true
        } elseif ($TargetIncognito -and $currentIncognito -ne $true) {
            $needsUpdate = $true
        } elseif (-not $TargetIncognito -and $currentIncognito -eq $true) {
            $needsUpdate = $true
        }

        if ($needsUpdate) {
            $result.SecureUpdate = $SecurePrefsPath
        }
        return $result
    }

    # Check regular Preferences
    $prefsPath = Join-Path (Split-Path -Parent $SecurePrefsPath) "Preferences"
    if (-not (Test-Path -LiteralPath $prefsPath)) {
        return $result
    }

    try {
        $prefsContent = [System.IO.File]::ReadAllText($prefsPath)
        $prefsData = $prefsContent | ConvertFrom-Json
    } catch {
        return $result
    }

    $prefsExtSettings = $prefsData.extensions.settings
    if ($null -ne $prefsExtSettings -and $null -ne $prefsExtSettings.$ExtensionId) {
        $prefsSettings = $prefsExtSettings.$ExtensionId
        $currentIncognito = $prefsSettings.incognito

        $needsUpdate = $false
        if ($null -eq $currentIncognito) {
            $needsUpdate = $true
        } elseif ($TargetIncognito -and $currentIncognito -ne $true) {
            $needsUpdate = $true
        } elseif (-not $TargetIncognito -and $currentIncognito -eq $true) {
            $needsUpdate = $true
        }

        if ($needsUpdate) {
            $result.PrefUpdate = $prefsPath
        }
    }

    return $result
}

function Get-ProfilesNeedingUpdate {
    param(
        [string[]]$Paths,
        [string]$ExtensionId,
        [bool]$TargetIncognito
    )

    $secureUpdates = New-Object System.Collections.Generic.List[string]
    $prefUpdates = New-Object System.Collections.Generic.List[string]

    # For small number of profiles, sequential is faster (no runspace overhead)
    if ($Paths.Count -le 3) {
        foreach ($path in $Paths) {
            $result = Test-ProfileNeedsUpdate -SecurePrefsPath $path -ExtensionId $ExtensionId -TargetIncognito $TargetIncognito
            if ($result.SecureUpdate) { $secureUpdates.Add($result.SecureUpdate) | Out-Null }
            if ($result.PrefUpdate) { $prefUpdates.Add($result.PrefUpdate) | Out-Null }
        }
    } else {
        # Parallel execution using runspace pool
        $runspacePool = [runspacefactory]::CreateRunspacePool(1, [Math]::Min($Paths.Count, [Environment]::ProcessorCount))
        $runspacePool.Open()

        $jobs = New-Object System.Collections.Generic.List[object]

        $scriptBlock = {
            param($SecurePrefsPath, $ExtensionId, $TargetIncognito)

            $result = @{ SecureUpdate = $null; PrefUpdate = $null }

            try {
                $content = [System.IO.File]::ReadAllText($SecurePrefsPath)
                $data = $content | ConvertFrom-Json
            } catch {
                return $result
            }

            $extSettings = $data.extensions.settings
            if ($null -ne $extSettings -and $null -ne $extSettings.$ExtensionId) {
                $settings = $extSettings.$ExtensionId
                $currentIncognito = $settings.incognito

                $needsUpdate = $false
                if ($null -eq $currentIncognito) { $needsUpdate = $true }
                elseif ($TargetIncognito -and $currentIncognito -ne $true) { $needsUpdate = $true }
                elseif (-not $TargetIncognito -and $currentIncognito -eq $true) { $needsUpdate = $true }

                if ($needsUpdate) { $result.SecureUpdate = $SecurePrefsPath }
                return $result
            }

            $prefsPath = Join-Path (Split-Path -Parent $SecurePrefsPath) "Preferences"
            if (-not (Test-Path -LiteralPath $prefsPath)) { return $result }

            try {
                $prefsContent = [System.IO.File]::ReadAllText($prefsPath)
                $prefsData = $prefsContent | ConvertFrom-Json
            } catch {
                return $result
            }

            $prefsExtSettings = $prefsData.extensions.settings
            if ($null -ne $prefsExtSettings -and $null -ne $prefsExtSettings.$ExtensionId) {
                $prefsSettings = $prefsExtSettings.$ExtensionId
                $currentIncognito = $prefsSettings.incognito

                $needsUpdate = $false
                if ($null -eq $currentIncognito) { $needsUpdate = $true }
                elseif ($TargetIncognito -and $currentIncognito -ne $true) { $needsUpdate = $true }
                elseif (-not $TargetIncognito -and $currentIncognito -eq $true) { $needsUpdate = $true }

                if ($needsUpdate) { $result.PrefUpdate = $prefsPath }
            }

            return $result
        }

        foreach ($path in $Paths) {
            $powershell = [powershell]::Create().AddScript($scriptBlock).AddArgument($path).AddArgument($ExtensionId).AddArgument($TargetIncognito)
            $powershell.RunspacePool = $runspacePool

            $jobs.Add(@{
                PowerShell = $powershell
                Handle = $powershell.BeginInvoke()
            }) | Out-Null
        }

        # Collect results
        foreach ($job in $jobs) {
            $result = $job.PowerShell.EndInvoke($job.Handle)
            if ($result.SecureUpdate) { $secureUpdates.Add($result.SecureUpdate) | Out-Null }
            if ($result.PrefUpdate) { $prefUpdates.Add($result.PrefUpdate) | Out-Null }
            $job.PowerShell.Dispose()
        }

        $runspacePool.Close()
        $runspacePool.Dispose()
    }

    return [pscustomobject]@{
        SecureUpdates = $secureUpdates.ToArray()
        PrefUpdates = $prefUpdates.ToArray()
    }
}
#endregion

#region Parallel Execution Helpers
function Get-ScriptFunctionEntries {
    $functions = Get-Command -CommandType Function | Where-Object { $_.ScriptBlock.File -eq $PSCommandPath }
    $entries = @()
    foreach ($function in $functions) {
        $entries += [pscustomobject]@{
            Name = $function.Name
            Definition = $function.Definition
        }
    }
    return $entries
}

function New-WorkerRunspacePool {
    param(
        [int]$MaxThreads,
        [object[]]$FunctionEntries
    )

    if ($null -eq $FunctionEntries -or $FunctionEntries.Count -eq 0) {
        if ($ScriptFunctionEntries) {
            $FunctionEntries = $ScriptFunctionEntries
        } else {
            $FunctionEntries = Get-ScriptFunctionEntries
        }
    }

    $iss = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
    foreach ($entry in $FunctionEntries) {
        $iss.Commands.Add(
            (New-Object System.Management.Automation.Runspaces.SessionStateFunctionEntry $entry.Name, $entry.Definition)
        )
    }

    $variables = @{
        extensionID = $extensionID
        EventLogName = $EventLogName
        EventLogSource = $EventLogSource
        EventIdInfo = $EventIdInfo
        EventIdWarning = $EventIdWarning
        EventIdError = $EventIdError
        EventIdDebug = $EventIdDebug
        Debug = $Debug
        chromeSeed = $chromeSeed
        emptySeed = $emptySeed
        ScriptFunctionEntries = $FunctionEntries
    }

    foreach ($pair in $variables.GetEnumerator()) {
        $iss.Variables.Add(
            (New-Object System.Management.Automation.Runspaces.SessionStateVariableEntry $pair.Key, $pair.Value, $null)
        )
    }

    $pool = [runspacefactory]::CreateRunspacePool(1, $MaxThreads, $iss, $host)
    $pool.Open()
    return $pool
}

function Invoke-ParallelProfileUpdates {
    param(
        [string[]]$Paths,
        [ValidateSet("Preferences", "Secure")]
        [string]$Mode,
        [bool]$TargetIncognito,
        [byte[]]$Seed,
        [string]$SID,
        [byte[]]$EncryptionKey
    )

    if ($null -eq $Paths -or $Paths.Count -eq 0) {
        return @()
    }

    if ($Paths.Count -le 1) {
        $path = $Paths[0]
        if ($Mode -eq "Preferences") {
            $payload = Update-PreferencesFile -PrefsPath $path -TargetIncognito $TargetIncognito
        } else {
            $payload = Build-UpdatedPayload -PrefsPath $path -Seed $Seed -SID $SID -EncryptionKey $EncryptionKey -TargetIncognito $TargetIncognito
        }

        if ($null -eq $payload) {
            return ,([pscustomobject]@{ Index = 0; Path = $path; Status = "PayloadFailed" })
        }

        $ok = Write-SecurePreferences -Path $path -Payload $payload
        $status = if ($ok) { "Success" } else { "WriteFailed" }
        return ,([pscustomobject]@{ Index = 0; Path = $path; Status = $status })
    }

    $maxThreads = [Math]::Min($Paths.Count, [Environment]::ProcessorCount)
    $pool = New-WorkerRunspacePool -MaxThreads $maxThreads -FunctionEntries $ScriptFunctionEntries
    $jobs = New-Object System.Collections.Generic.List[object]

    $scriptBlock = {
        param($Index, $Path, $Mode, $TargetIncognito, $Seed, $SID, $EncryptionKey)

        if ($Mode -eq "Preferences") {
            $payload = Update-PreferencesFile -PrefsPath $Path -TargetIncognito $TargetIncognito
        } else {
            $payload = Build-UpdatedPayload -PrefsPath $Path -Seed $Seed -SID $SID -EncryptionKey $EncryptionKey -TargetIncognito $TargetIncognito
        }

        if ($null -eq $payload) {
            return [pscustomobject]@{ Index = $Index; Path = $Path; Status = "PayloadFailed" }
        }

        $ok = Write-SecurePreferences -Path $Path -Payload $payload
        if ($ok) {
            return [pscustomobject]@{ Index = $Index; Path = $Path; Status = "Success" }
        }

        return [pscustomobject]@{ Index = $Index; Path = $Path; Status = "WriteFailed" }
    }

    for ($i = 0; $i -lt $Paths.Count; $i++) {
        $path = $Paths[$i]
        $powershell = [powershell]::Create().AddScript($scriptBlock).
            AddArgument($i).AddArgument($path).AddArgument($Mode).
            AddArgument($TargetIncognito).AddArgument($Seed).
            AddArgument($SID).AddArgument($EncryptionKey)
        $powershell.RunspacePool = $pool

        $jobs.Add(@{
            PowerShell = $powershell
            Handle = $powershell.BeginInvoke()
        }) | Out-Null
    }

    $results = New-Object System.Collections.Generic.List[object]
    foreach ($job in $jobs) {
        $result = $job.PowerShell.EndInvoke($job.Handle)
        if ($result) {
            $results.Add($result) | Out-Null
        }
        $job.PowerShell.Dispose()
    }

    $pool.Close()
    $pool.Dispose()

    return $results.ToArray()
}

function Invoke-BrowserUpdatePlan {
    param(
        [pscustomobject]$Plan,
        [bool]$TargetIncognito,
        [string]$SID
    )

    if ($null -eq $Plan) {
        return $null
    }

    $browser = $Plan.Browser
    $name = $browser.Name
    $processName = $browser.ProcessName
    $profileRoot = $browser.ProfileRoot
    $localStatePath = $browser.LocalState

    $secureUpdates = $Plan.SecureUpdates
    $prefUpdates = $Plan.PrefUpdates
    $shouldRestart = $false

    Write-EventLogEntry "Applying updates for $name..." -EventId $EventIdInfo

    $runningState = Test-BrowserRunning $processName
    if ($runningState.IsRunning) {
        Write-EventLogEntry "  Stopping $name..." -EventId $EventIdInfo
        if ($processName -eq "msedge") {
            Disable-EdgeBackgroundMode
            Stop-BrowserImmediate $processName
        } else {
            Stop-Browser $processName
            if (-not (Ensure-BrowserStopped -ProcessName $processName -TimeoutSeconds 1 -RetryDelayMs 250)) {
                Write-EventLogEntry "  Failed to stop $name, skipping updates" -EntryType "Warning" -EventId $EventIdWarning
                return [pscustomobject]@{ Browser = $name; Status = "StopFailed" }
            }
        }
        $shouldRestart = $runningState.HasWindow
    }

    if ($prefUpdates.Count -gt 0) {
        $prefResults = Invoke-ParallelProfileUpdates -Paths $prefUpdates -Mode "Preferences" -TargetIncognito $TargetIncognito
        foreach ($result in ($prefResults | Sort-Object Index)) {
            Write-EventLogEntry "  Updating Preferences: $($result.Path)" -EventId $EventIdInfo
            if ($result.Status -eq "Success") {
                Write-EventLogEntry "    Updated Preferences successfully" -EventId $EventIdInfo
            } elseif ($result.Status -eq "PayloadFailed") {
                Write-EventLogEntry "    Failed to build Preferences payload" -EntryType "Error" -EventId $EventIdError
            } else {
                Write-EventLogEntry "    Failed to write Preferences" -EntryType "Error" -EventId $EventIdError
            }
        }
    }

    if ($secureUpdates.Count -gt 0) {
        $seed = Get-SeedForBrowser -BrowserName $name
        Write-EventLogEntry "  Using seed length: $($seed.Length)" -EventId $EventIdInfo

        $encryptionKey = Get-EncryptionKey $localStatePath
        if ($null -eq $encryptionKey) {
            Write-EventLogEntry "  Could not get encryption key, skipping Secure Preferences" -EntryType "Warning" -EventId $EventIdWarning
        } else {
            $secureResults = Invoke-ParallelProfileUpdates -Paths $secureUpdates -Mode "Secure" -TargetIncognito $TargetIncognito -Seed $seed -SID $SID -EncryptionKey $encryptionKey
            foreach ($result in ($secureResults | Sort-Object Index)) {
                Write-EventLogEntry "  Updating Secure Preferences: $($result.Path)" -EventId $EventIdInfo
                if ($result.Status -eq "Success") {
                    Write-EventLogEntry "    Updated Secure Preferences successfully" -EventId $EventIdInfo
                } elseif ($result.Status -eq "PayloadFailed") {
                    Write-EventLogEntry "    Failed to build Secure Preferences payload" -EntryType "Error" -EventId $EventIdError
                } else {
                    Write-EventLogEntry "    Failed to write Secure Preferences" -EntryType "Error" -EventId $EventIdError
                }
            }
        }
    }

    if ($shouldRestart) {
        Write-EventLogEntry "  Restarting $name..." -EventId $EventIdInfo
        Start-Browser -Name $name -ProfileRoot $profileRoot
    }

    return [pscustomobject]@{ Browser = $name; Status = "Done" }
}

function Invoke-ParallelBrowserScan {
    param(
        [object[]]$Browsers,
        [string]$ExtensionId,
        [bool]$TargetIncognito,
        [object[]]$FunctionEntries
    )

    if ($null -eq $Browsers -or $Browsers.Count -eq 0) {
        return @()
    }

    if ($Browsers.Count -le 1) {
        $browser = $Browsers[0]
        try {
            $profileRoot = $browser.ProfileRoot

            if (-not (Test-Path $profileRoot)) {
                return ,([pscustomobject]@{ Index = 0; Browser = $browser; Status = "ProfileRootMissing" })
            }

            $prefsPaths = Get-SecurePrefsPaths $profileRoot
            if ($prefsPaths.Count -eq 0) {
                return ,([pscustomobject]@{ Index = 0; Browser = $browser; Status = "NoProfiles"; PrefsPathsCount = 0 })
            }

            $plan = Get-ProfilesNeedingUpdate -Paths $prefsPaths -ExtensionId $ExtensionId -TargetIncognito $TargetIncognito
            $secureUpdates = $plan.SecureUpdates
            $prefUpdates = $plan.PrefUpdates
            $status = if ($secureUpdates.Count -eq 0 -and $prefUpdates.Count -eq 0) { "NoUpdates" } else { "Planned" }

            return ,([pscustomobject]@{
                Index = 0
                Browser = $browser
                Status = $status
                PrefsPathsCount = $prefsPaths.Count
                SecureUpdates = $secureUpdates
                PrefUpdates = $prefUpdates
            })
        } catch {
            return ,([pscustomobject]@{
                Index = 0
                Browser = $browser
                Status = "ScanFailed"
                Error = $_.Exception.Message
            })
        }
    }

    $maxThreads = [Math]::Min($Browsers.Count, [Environment]::ProcessorCount)
    $pool = New-WorkerRunspacePool -MaxThreads $maxThreads -FunctionEntries $FunctionEntries
    $jobs = New-Object System.Collections.Generic.List[object]

    $scriptBlock = {
        param($Index, $Browser, $ExtensionId, $TargetIncognito)

        try {
            $profileRoot = $Browser.ProfileRoot
            if (-not (Test-Path $profileRoot)) {
                return [pscustomobject]@{ Index = $Index; Browser = $Browser; Status = "ProfileRootMissing" }
            }

            $prefsPaths = Get-SecurePrefsPaths $profileRoot
            if ($prefsPaths.Count -eq 0) {
                return [pscustomobject]@{ Index = $Index; Browser = $Browser; Status = "NoProfiles"; PrefsPathsCount = 0 }
            }

            $plan = Get-ProfilesNeedingUpdate -Paths $prefsPaths -ExtensionId $ExtensionId -TargetIncognito $TargetIncognito
            $secureUpdates = $plan.SecureUpdates
            $prefUpdates = $plan.PrefUpdates
            $status = if ($secureUpdates.Count -eq 0 -and $prefUpdates.Count -eq 0) { "NoUpdates" } else { "Planned" }

            return [pscustomobject]@{
                Index = $Index
                Browser = $Browser
                Status = $status
                PrefsPathsCount = $prefsPaths.Count
                SecureUpdates = $secureUpdates
                PrefUpdates = $prefUpdates
            }
        } catch {
            return [pscustomobject]@{
                Index = $Index
                Browser = $Browser
                Status = "ScanFailed"
                Error = $_.Exception.Message
            }
        }
    }

    for ($i = 0; $i -lt $Browsers.Count; $i++) {
        $browser = $Browsers[$i]
        $powershell = [powershell]::Create().AddScript($scriptBlock).
            AddArgument($i).AddArgument($browser).AddArgument($ExtensionId).AddArgument($TargetIncognito)
        $powershell.RunspacePool = $pool

        $jobs.Add(@{
            PowerShell = $powershell
            Handle = $powershell.BeginInvoke()
        }) | Out-Null
    }

    $results = New-Object System.Collections.Generic.List[object]
    foreach ($job in $jobs) {
        $result = $job.PowerShell.EndInvoke($job.Handle)
        if ($result) {
            $results.Add($result) | Out-Null
        }
        $job.PowerShell.Dispose()
    }

    $pool.Close()
    $pool.Dispose()

    return $results.ToArray()
}

function Invoke-ParallelBrowserUpdates {
    param(
        [object[]]$Plans,
        [bool]$TargetIncognito,
        [string]$SID,
        [object[]]$FunctionEntries
    )

    if ($null -eq $Plans -or $Plans.Count -eq 0) {
        return @()
    }

    if ($Plans.Count -le 1) {
        return ,(Invoke-BrowserUpdatePlan -Plan $Plans[0] -TargetIncognito $TargetIncognito -SID $SID)
    }

    $maxThreads = [Math]::Min($Plans.Count, [Environment]::ProcessorCount)
    $pool = New-WorkerRunspacePool -MaxThreads $maxThreads -FunctionEntries $FunctionEntries
    $jobs = New-Object System.Collections.Generic.List[object]

    $scriptBlock = {
        param($Index, $Plan, $TargetIncognito, $SID)

        $result = Invoke-BrowserUpdatePlan -Plan $Plan -TargetIncognito $TargetIncognito -SID $SID
        if ($null -eq $result) {
            return [pscustomobject]@{ Index = $Index; Browser = $null; Status = "NoResult" }
        }

        return [pscustomobject]@{
            Index = $Index
            Browser = $result.Browser
            Status = $result.Status
        }
    }

    for ($i = 0; $i -lt $Plans.Count; $i++) {
        $plan = $Plans[$i]
        $powershell = [powershell]::Create().AddScript($scriptBlock).
            AddArgument($i).AddArgument($plan).AddArgument($TargetIncognito).AddArgument($SID)
        $powershell.RunspacePool = $pool

        $jobs.Add(@{
            PowerShell = $powershell
            Handle = $powershell.BeginInvoke()
        }) | Out-Null
    }

    $results = New-Object System.Collections.Generic.List[object]
    foreach ($job in $jobs) {
        $result = $job.PowerShell.EndInvoke($job.Handle)
        if ($result) {
            $results.Add($result) | Out-Null
        }
        $job.PowerShell.Dispose()
    }

    $pool.Close()
    $pool.Dispose()

    return $results.ToArray()
}
#endregion


#region Validate Seed
function Test-Seed {
    param(
        [string]$PrefsPath,
        [byte[]]$Seed,
        [string]$SID
    )

    $data = Read-JsonFile -Path $PrefsPath
    if ($null -eq $data) { return $false }

    $target = Find-SeedTestTarget $data
    if ($null -eq $target) {
        Write-DebugLog "No seed test target found"
        return $false
    }

    Write-DebugLog "Testing seed with path: $($target.Path)"
    Write-DebugLog "Expected MAC: $($target.Mac)"

    $calculatedMac = Calculate-HMAC -Value $target.Value -Path $target.Path -SID $SID -Seed $Seed

    Write-DebugLog "Calculated MAC: $calculatedMac"

    return $calculatedMac -eq $target.Mac
}
#endregion

#region Build Updated Payload
function Build-UpdatedPayload {
    param(
        [string]$PrefsPath,
        [byte[]]$Seed,
        [string]$SID,
        [byte[]]$EncryptionKey,
        [bool]$TargetIncognito
    )

    $data = Read-JsonFile -Path $PrefsPath
    if ($null -eq $data) { return $null }

    $settings = Get-ValueByPath $data @("extensions", "settings", $extensionID)
    if ($null -eq $settings) {
        Write-EventLogEntry "Extension settings not found for $extensionID" -EntryType "Warning" -EventId $EventIdWarning
        return $null
    }

    # Update settings with incognito flag
    $updatedSettings = Insert-IncognitoAfterGrantedPermissions -Settings $settings -IncognitoValue $TargetIncognito
    Set-ValueByPath $data @("extensions", "settings", $extensionID) $updatedSettings

    # Order: update settings -> mac -> encrypted hash -> super_mac.
    # Calculate new MAC for extension settings
    $macPath = "extensions.settings.$extensionID"
    $jsonVariants = Get-CleanJsonVariants -Value $updatedSettings
    $newMac = Calculate-HMAC -Value $updatedSettings -Path $macPath -SID $SID -Seed $Seed -JsonValue $jsonVariants.HmacJson

    if ($Debug) {
        $existingMac = Get-ValueByPath $data @("protection", "macs", "extensions", "settings", $extensionID)
        Write-DebugLog "Existing MAC for extension: $existingMac"
    }
    Write-DebugLog "New MAC for extension: $newMac"
    

    Set-ValueByPath $data @("protection", "macs", "extensions", "settings", $extensionID) $newMac

    # Calculate encrypted hash
    $encryptedHash = Calculate-EncryptedHash -Seed $Seed -Path $macPath -Value $updatedSettings -EncryptionKey $EncryptionKey -JsonValue $jsonVariants.EncryptedJson
    if ($Debug) {
        $existingEnc = Get-ValueByPath $data @("protection", "macs", "extensions", "settings_encrypted_hash", $extensionID)
        Write-DebugLog "Existing encrypted hash: $existingEnc"
    }
    Write-DebugLog "New encrypted hash: $encryptedHash"
    
    Set-ValueByPath $data @("protection", "macs", "extensions", "settings_encrypted_hash", $extensionID) $encryptedHash

    # Calculate super_mac after macs/settings_encrypted_hash are updated
    $macs = Get-ValueByPath $data @("protection", "macs")
    $superMacValue = Calculate-SuperMac -Macs $macs -SID $SID -Seed $Seed

    if ($Debug) {
        $existingSuperMac = Get-ValueByPath $data @("protection", "super_mac")
        Write-DebugLog "Existing super_mac: $existingSuperMac"
    }
    Write-DebugLog "New super_mac: $superMacValue"
    

    Set-ValueByPath $data @("protection", "super_mac") $superMacValue

    # Convert to JSON
    $payload = ConvertTo-JsonCompact $data
    $payload = $payload.Replace("<", "\u003C")

    return $payload
}
#endregion

#region Update Preferences File (no HMAC)
function Update-PreferencesFile {
    param(
        [string]$PrefsPath,
        [bool]$TargetIncognito
    )

    $data = Read-JsonFile -Path $PrefsPath
    if ($null -eq $data) { return $null }

    $settings = Get-ValueByPath $data @("extensions", "settings", $extensionID)
    if ($settings -isnot [System.Collections.IDictionary]) {
        Write-DebugLog "Extension settings missing in Preferences: $PrefsPath"
        return $null
    }

    $updatedSettings = Insert-IncognitoAfterGrantedPermissions -Settings $settings -IncognitoValue $TargetIncognito
    Set-ValueByPath $data @("extensions", "settings", $extensionID) $updatedSettings

    $payload = ConvertTo-JsonCompact $data
    $payload = $payload.Replace("<", "\u003C")

    return $payload
}
#endregion

#region Write Secure Preferences
function Write-SecurePreferences {
    param(
        [string]$Path,
        [string]$Payload
    )

    $tmpPath = $Path + ".tmp"

    try {
        $utf8NoBom = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($tmpPath, $Payload + "`n", $utf8NoBom)

        Move-Item -Path $tmpPath -Destination $Path -Force

        return $true
    }
    catch {
        Write-EventLogEntry "Error writing Secure Preferences: $_" -EntryType "Error" -EventId $EventIdError
        if (Test-Path $tmpPath) {
            Remove-Item $tmpPath -Force -ErrorAction SilentlyContinue
        }
        return $false
    }
}
#endregion

#region Is Browser Running
function Test-BrowserRunning {
    param([string]$ProcessName)

    $processes = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
    if ($null -eq $processes) {
        return [pscustomobject]@{
            IsRunning = $false
            HasWindow = $false
        }
    }

    $hasWindow = $false
    foreach ($proc in @($processes)) {
        if ($proc.MainWindowHandle -ne 0) {
            $hasWindow = $true
            break
        }
    }

    return [pscustomobject]@{
        IsRunning = $true
        HasWindow = $hasWindow
    }
}
#endregion

#region Edge Background Policies
function Disable-EdgeBackgroundMode {
    $policyPath = "HKCU:\\Software\\Policies\\Microsoft\\Edge"
    try {
        if (-not (Test-Path $policyPath)) {
            New-Item -Path $policyPath -Force | Out-Null
        }
        New-ItemProperty -Path $policyPath -Name "BackgroundModeEnabled" -Value 0 -PropertyType DWord -Force | Out-Null
        New-ItemProperty -Path $policyPath -Name "StartupBoostEnabled" -Value 0 -PropertyType DWord -Force | Out-Null
    } catch {
        Write-EventLogEntry "Failed to disable Edge background mode: $($_.Exception.Message)" -EntryType "Warning" -EventId $EventIdWarning
    }
}
#endregion

#region Stop Browser
function Stop-Browser {
    param([string]$ProcessName)

    $processes = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
    if ($null -eq $processes) { return }

    foreach ($proc in $processes) {
        try {
            $proc.CloseMainWindow() | Out-Null
        }
        catch {}
    }

    Start-Sleep -Milliseconds 500

    # Force kill if still running
    $processes = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
    if ($null -ne $processes) {
        foreach ($proc in $processes) {
            try {
                $proc.Kill()
            }
            catch {}
        }
    }

    Start-Sleep -Milliseconds 500
}
#endregion

#region Stop Browser Immediate
function Stop-BrowserImmediate {
    param([string]$ProcessName)

    $processes = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
    if ($null -eq $processes) { return }

    foreach ($proc in $processes) {
        try {
            $proc.Kill()
        }
        catch {}
    }
}
#endregion

#region Ensure Browser Stopped
function Ensure-BrowserStopped {
    param(
        [string]$ProcessName,
        [int]$TimeoutSeconds = 15,
        [int]$RetryDelayMs = 500
    )

    if ([string]::IsNullOrWhiteSpace($ProcessName)) {
        return $true
    }

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $state = Test-BrowserRunning $ProcessName
    while ($true) {
        if (-not $state.IsRunning) {
            return $true
        }

        Stop-Browser $ProcessName

        if ((Get-Date) -ge $deadline) {
            return $false
        }

        Start-Sleep -Milliseconds $RetryDelayMs
        $state = Test-BrowserRunning $ProcessName
    }
}
#endregion

#region Start Browser
function Start-Browser {
    param(
        [string]$Name,
        [string]$ProfileRoot
    )

    $exePaths = @()

    switch ($Name) {
        "Chrome" {
            $exePaths += "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
            $exePaths += "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
        }
        "Edge" {
            $exePaths += "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
            $exePaths += "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
        }
        "Brave" {
            $exePaths += "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe"
            $exePaths += "${env:ProgramFiles(x86)}\BraveSoftware\Brave-Browser\Application\brave.exe"
        }
        "Chromium" {
            $exePaths += "$env:LOCALAPPDATA\Chromium\Application\chrome.exe"
        }
        "Opera" {
            $exePaths += "$env:LOCALAPPDATA\Programs\Opera\opera.exe"
        }
        "Vivaldi" {
            $exePaths += "$env:LOCALAPPDATA\Vivaldi\Application\vivaldi.exe"
        }
    }

    foreach ($exePath in $exePaths) {
        if (Test-Path $exePath) {
            Start-Process -FilePath $exePath -ArgumentList "--restore-last-session"
            return
        }
    }
}
#endregion

#region Main Script

$targetIncognito = -not $Disable

Write-EventLogEntry "IncognitoEnforcer for Windows" -EventId $EventIdInfo
Write-EventLogEntry "Target incognito: $targetIncognito" -EventId $EventIdInfo

$sid = Get-WindowsSID
Write-EventLogEntry "Windows SID (trimmed): $sid" -EventId $EventIdInfo

$ScriptFunctionEntries = Get-ScriptFunctionEntries

$browserPlans = @()

$scanResults = Invoke-ParallelBrowserScan -Browsers $browsers -ExtensionId $extensionID -TargetIncognito $targetIncognito -FunctionEntries $ScriptFunctionEntries
foreach ($result in ($scanResults | Sort-Object Index)) {
    $browser = $result.Browser
    if ($null -eq $browser) {
        continue
    }

    $name = $browser.Name
    Write-EventLogEntry "Scanning $name..." -EventId $EventIdInfo

    if ($result.Status -eq "ProfileRootMissing") {
        Write-EventLogEntry "  Profile root not found, skipping" -EntryType "Warning" -EventId $EventIdWarning
        continue
    }

    if ($result.Status -eq "NoProfiles") {
        Write-EventLogEntry "  No profiles found, skipping" -EntryType "Warning" -EventId $EventIdWarning
        continue
    }

    if ($result.Status -eq "ScanFailed") {
        Write-EventLogEntry "  Scan failed, skipping" -EntryType "Warning" -EventId $EventIdWarning
        continue
    }

    Write-EventLogEntry "  Found $($result.PrefsPathsCount) profile(s)" -EventId $EventIdInfo

    if ($result.Status -eq "NoUpdates") {
        Write-EventLogEntry "  Nothing to update, skipping" -EventId $EventIdInfo
        continue
    }

    Write-EventLogEntry "  Secure Preferences updates: $($result.SecureUpdates.Count)" -EventId $EventIdInfo
    Write-EventLogEntry "  Preferences updates: $($result.PrefUpdates.Count)" -EventId $EventIdInfo

    $browserPlans += [pscustomobject]@{
        Browser = $browser
        SecureUpdates = $result.SecureUpdates
        PrefUpdates = $result.PrefUpdates
    }
}

$null = Invoke-ParallelBrowserUpdates -Plans $browserPlans -TargetIncognito $targetIncognito -SID $sid -FunctionEntries $ScriptFunctionEntries

Write-EventLogEntry "Done!" -EventId $EventIdInfo

#endregion

'@


        $scriptPath = "$env:ProgramData\SquareX\incognito_enforcer.ps1"
        $scriptDir = Split-Path $scriptPath -Parent
        
       
        if (-not (Test-Path $scriptDir)) {
            New-Item -Path $scriptDir -ItemType Directory -Force | Out-Null
        }
        
       
        $incognitoEnforcerScript | Out-File -FilePath $scriptPath -Encoding UTF8 -Force

        Write-EventLog -LogName $EventLogName -Source $EventLogSource -EntryType Information -EventId 1000 -Message "Incognito enforcer script written to: $scriptPath"


        # try {
        #     & PowerShell.exe -ExecutionPolicy Bypass -File $scriptPath
        #     Write-EventLog -LogName $EventLogName -Source $EventLogSource -EntryType Information -EventId 1000 -Message "Incognito enforcer script executed successfully"
        # } catch {
        #     Write-EventLog -LogName $EventLogName -Source $EventLogSource -EntryType Warning -EventId 1002 -Message "Failed to execute incognito enforcer script immediately: $($_.Exception.Message)"
        # }
        
        # Create a scheduled task to run the script on user logon
        $taskName = "SquareX_IncognitoEnforcer"
        $taskDescription = "SquareX Incognito Enforcer"
        
        
        $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($existingTask) {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
            Write-EventLog -LogName $EventLogName -Source $EventLogSource -EntryType Information -EventId 1000 -Message "Removed existing scheduled task: $taskName"
        }
        
        
        $action = New-ScheduledTaskAction -Execute "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""
        
        
        $trigger = New-ScheduledTaskTrigger -AtLogOn
        
       
        $principal = New-ScheduledTaskPrincipal -GroupId "BUILTIN\Users" -RunLevel Limited
        
        
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -DontStopOnIdleEnd -Priority 0
        
        
        Register-ScheduledTask -TaskName $taskName -Description $taskDescription -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
        
        Write-EventLog -LogName $EventLogName -Source $EventLogSource -EntryType Information -EventId 1000 -Message "Scheduled task '$taskName' created successfully for user logon"
        
    } catch {
        Write-ErrorAndExit "Failed to setup Incognito Enforcer" $_
    }
}
EnforceInIncognito
