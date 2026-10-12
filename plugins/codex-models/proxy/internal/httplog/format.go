package httplog

import (
	"strconv"
	"time"
)

// sizeUnits are the binary multiples formatSize steps through.
var sizeUnits = [...]string{"Kb", "Mb", "Gb", "Tb"}

// formatSize renders a byte count for a line: plain bytes under 1024, then
// the largest unit (up to Tb) that keeps the number under 1024, with at most
// one decimal ("1.5Kb", "1Mb"). A negative count is an unknown size ("?").
func formatSize(n int64) string {
	if n < 0 {
		return "?"
	}
	if n < 1024 {
		return strconv.FormatInt(n, 10) + "b"
	}
	unit, scale := 0, int64(1024)
	for unit < len(sizeUnits)-1 && n/scale >= 1024 {
		unit++
		scale *= 1024
	}
	// Tenths of the unit, rounded half up, in integers so a huge count
	// cannot overflow.
	tenths := n/scale*10 + (n%scale*10+scale/2)/scale
	if tenths >= 10240 && unit < len(sizeUnits)-1 {
		// Rounding reached 1024 of this unit: show one of the next.
		unit++
		scale *= 1024
		tenths = n/scale*10 + (n%scale*10+scale/2)/scale
	}
	text := strconv.FormatInt(tenths/10, 10)
	if frac := tenths % 10; frac != 0 {
		text += "." + strconv.FormatInt(frac, 10)
	}
	return text + sizeUnits[unit]
}

// formatDuration renders a duration rounded to the millisecond.
func formatDuration(d time.Duration) string {
	return d.Round(time.Millisecond).String()
}
