# Dot-source helper: reports cloud-file state (logical size, size on disk, attribute flags) for given paths.
Add-Type -Name Disk -Namespace Win32 -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern uint GetCompressedFileSizeW(string lpFileName, out uint lpFileSizeHigh);
'@ -ErrorAction SilentlyContinue

function Get-CloudFileState {
    param([string[]]$Paths)
    foreach ($p in $Paths) {
        $fi = Get-Item -LiteralPath $p -Force
        $high = [uint32]0
        $low = [Win32.Disk]::GetCompressedFileSizeW($p, [ref]$high)
        $onDisk = ([uint64]$high -shl 32) -bor $low
        $attr = [uint32]$fi.Attributes.value__
        [pscustomobject]@{
            Name        = $fi.Name
            Logical     = $fi.Length
            OnDisk      = $onDisk
            Pinned      = [bool]($attr -band 0x80000)
            Unpinned    = [bool]($attr -band 0x100000)
            Offline     = [bool]($attr -band 0x1000)
            RecallOpen  = [bool]($attr -band 0x40000)
            RecallData  = [bool]($attr -band 0x400000)
            Reparse     = [bool]($attr -band 0x400)
            AttrHex     = '0x{0:X}' -f $attr
        }
    }
}
