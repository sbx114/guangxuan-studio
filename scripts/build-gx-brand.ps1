[CmdletBinding()]
param([string]$OutputDirectory = (Join-Path $PSScriptRoot '../desktop'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$gxRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$gxOutput = [IO.Path]::GetFullPath($OutputDirectory)
[void][IO.Directory]::CreateDirectory($gxOutput)
$gxCulture = [Globalization.CultureInfo]::InvariantCulture
function Gx-Number([double]$Value) { return $Value.ToString('0.###',$gxCulture) }
function Gx-RoundedPath([single]$X,[single]$Y,[single]$Width,[single]$Height,[single]$Radius) {
    $result = [Drawing.Drawing2D.GraphicsPath]::new()
    $diameter = 2 * $Radius
    $result.AddArc($X,$Y,$diameter,$diameter,180,90)
    $result.AddArc(($X+$Width-$diameter),$Y,$diameter,$diameter,270,90)
    $result.AddArc(($X+$Width-$diameter),($Y+$Height-$diameter),$diameter,$diameter,0,90)
    $result.AddArc($X,($Y+$Height-$diameter),$diameter,$diameter,90,90)
    $result.CloseFigure()
    return ,$result
}
function Gx-SvgPath([Drawing.Drawing2D.GraphicsPath]$Path) {
    $points = $Path.PathPoints; $types = $Path.PathTypes
    $segments = [Collections.Generic.List[string]]::new()
    for ($index=0; $index -lt $points.Length; $index++) {
        $type = $types[$index] -band 7
        $point = (Gx-Number $points[$index].X) + ' ' + (Gx-Number $points[$index].Y)
        if ($type -eq 0) { $segments.Add('M' + $point) }
        elseif ($type -eq 1) { $segments.Add('L' + $point) }
        elseif ($type -eq 3) {
            if ($index+2 -ge $points.Length) { throw 'Incomplete Bezier glyph.' }
            $segments.Add('C' + $point + ' ' + (Gx-Number $points[$index+1].X) + ' ' + (Gx-Number $points[$index+1].Y) + ' ' + (Gx-Number $points[$index+2].X) + ' ' + (Gx-Number $points[$index+2].Y))
            $index += 2
        } else { throw 'Unsupported glyph point.' }
        if ($types[$index] -band 128) { $segments.Add('Z') }
    }
    return [string]::Join('', $segments)
}

$gxFonts = [Drawing.Text.PrivateFontCollection]::new()
$gxFonts.AddFontFile((Join-Path $env:WINDIR 'Fonts/seguisb.ttf'))
$gxFamily = $gxFonts.Families[0]
$gxGlyph = [Drawing.Drawing2D.GraphicsPath]::new()
$gxGlyph.AddString('Gx',$gxFamily,[int][Drawing.FontStyle]::Regular,[single]600,[Drawing.PointF]::new(0,0),[Drawing.StringFormat]::GenericTypographic)
$gxBounds = $gxGlyph.GetBounds()
$gxScale = 694 / $gxBounds.Width
$gxTransform = [Drawing.Drawing2D.Matrix]::new([single]$gxScale,0,0,[single]$gxScale,[single](512-($gxBounds.X+$gxBounds.Width/2)*$gxScale),[single](515-($gxBounds.Y+$gxBounds.Height/2)*$gxScale))
$gxGlyph.Transform($gxTransform)
$gxGlyphPath = Gx-SvgPath $gxGlyph
$gxSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><linearGradient id="ivory" x2="0" y2="1"><stop stop-color="#faf6ee"/><stop offset="1" stop-color="#ebe3d4"/></linearGradient></defs><rect x="24" y="24" width="976" height="976" rx="128" fill="url(#ivory)"/><rect x="31" y="31" width="962" height="962" rx="122" fill="none" stroke="#cfc3ad" stroke-width="10"/><path d="' + $gxGlyphPath + '" fill="#625a4c"/></svg>'
[IO.File]::WriteAllText((Join-Path $gxOutput 'icon.svg'),$gxSvg,[Text.UTF8Encoding]::new($false))

$gxBack = Gx-RoundedPath 24 24 976 976 128
$gxRim = Gx-RoundedPath 31 31 962 962 122
function Gx-Png([int]$Size) {
    $bitmap = [Drawing.Bitmap]::new($Size,$Size,[Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $stream = [IO.MemoryStream]::new()
    try {
        $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.Clear([Drawing.Color]::Transparent)
        $graphics.ScaleTransform(($Size/1024),($Size/1024))
        $brush = [Drawing.Drawing2D.LinearGradientBrush]::new([Drawing.Point]::new(0,24),[Drawing.Point]::new(0,1000),[Drawing.ColorTranslator]::FromHtml('#faf6ee'),[Drawing.ColorTranslator]::FromHtml('#ebe3d4'))
        $rim = [Drawing.Pen]::new([Drawing.ColorTranslator]::FromHtml('#cfc3ad'),10)
        $ink = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#625a4c'))
        try { $graphics.FillPath($brush,$gxBack); $graphics.DrawPath($rim,$gxRim); $graphics.FillPath($ink,$gxGlyph) }
        finally { $brush.Dispose(); $rim.Dispose(); $ink.Dispose() }
        $bitmap.Save($stream,[Drawing.Imaging.ImageFormat]::Png)
        return ,$stream.ToArray()
    } finally { $graphics.Dispose(); $bitmap.Dispose(); $stream.Dispose() }
}
[IO.File]::WriteAllBytes((Join-Path $gxOutput 'icon.png'),(Gx-Png 512))
$gxSizes = @(256,128,64,48,32,24,16)
$gxImages = @($gxSizes | ForEach-Object { ,(Gx-Png $_) })
$gxIco = [IO.MemoryStream]::new(); $gxWriter = [IO.BinaryWriter]::new($gxIco)
try {
    $gxWriter.Write([uint16]0); $gxWriter.Write([uint16]1); $gxWriter.Write([uint16]$gxSizes.Count)
    $offset = 6 + 16 * $gxSizes.Count
    for ($index=0; $index -lt $gxSizes.Count; $index++) {
        $dimension = if ($gxSizes[$index] -eq 256) { 0 } else { $gxSizes[$index] }
        $gxWriter.Write([byte]$dimension); $gxWriter.Write([byte]$dimension); $gxWriter.Write([byte]0); $gxWriter.Write([byte]0)
        $gxWriter.Write([uint16]1); $gxWriter.Write([uint16]32); $gxWriter.Write([uint32]$gxImages[$index].Length); $gxWriter.Write([uint32]$offset)
        $offset += $gxImages[$index].Length
    }
    foreach ($bytes in $gxImages) { $gxWriter.Write([byte[]]$bytes) }
    $gxWriter.Flush(); [IO.File]::WriteAllBytes((Join-Path $gxOutput 'icon.ico'),$gxIco.ToArray())
} finally { $gxWriter.Dispose(); $gxIco.Dispose() }

foreach ($relative in @('public/mark.svg','integrations/rhinelab-ui/public/favicon.svg')) {
    [IO.File]::WriteAllText((Join-Path $gxRoot $relative),$gxSvg,[Text.UTF8Encoding]::new($false))
}
$gxGlyphFile = Join-Path $gxOutput 'gx-glyph.svg'
[IO.File]::WriteAllText($gxGlyphFile,('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><path d="' + $gxGlyphPath + '" fill="currentColor"/></svg>'),[Text.UTF8Encoding]::new($false))
$gxTransform.Dispose(); $gxGlyph.Dispose(); $gxBack.Dispose(); $gxRim.Dispose(); $gxFonts.Dispose()
[PSCustomObject]@{ svg=(Join-Path $gxOutput 'icon.svg');png=(Join-Path $gxOutput 'icon.png');ico=(Join-Path $gxOutput 'icon.ico');sizes=$gxSizes; glyph=$gxGlyphFile } | ConvertTo-Json
