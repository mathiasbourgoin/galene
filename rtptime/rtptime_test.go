package rtptime

import (
	"testing"
	"time"
)

func TestDuration(t *testing.T) {
	a := FromDuration(time.Second, 48000)
	if a != 48000 {
		t.Errorf("Expected 48000, got %v", a)
	}

	b := FromDuration(-time.Second, 48000)
	if b != -48000 {
		t.Errorf("Expected -48000, got %v", b)
	}

	c := ToDuration(48000, 48000)
	if c != time.Second {
		t.Errorf("Expected %v, got %v", time.Second, c)
	}

	d := ToDuration(-48000, 48000)
	if d != -time.Second {
		t.Errorf("Expected %v, got %v", -time.Second, d)
	}
}

func TestDurationOverflow(t *testing.T) {
	delta := 10 * time.Minute
	dj := FromDuration(delta, JiffiesPerSec)
	var prev int64
	for d := time.Duration(0); d < time.Duration(1000*time.Hour); d += delta {
		jiffies := FromDuration(d, JiffiesPerSec)
		if d != 0 {
			if jiffies != prev+dj {
				t.Errorf("%v: %v, %v", d, jiffies, prev)
			}
		}
		d2 := ToDuration(jiffies, JiffiesPerSec)
		if d2 != d {
			t.Errorf("%v != %v (%v)", d2, d, jiffies)
		}
		prev = jiffies
	}
}

func differs(a, b, delta uint64) bool {
	if a < b {
		a, b = b, a
	}
	return a-b >= delta
}

func TestTime(t *testing.T) {
	check := func(name string, clock func() uint64, hz uint32, delay time.Duration) {
		t.Helper()
		before := time.Now()
		a := clock()
		time.Sleep(delay)
		b := clock()
		after := time.Now()
		max := uint64(FromDuration(after.Sub(before), hz)) + 2
		min := uint64(FromDuration(delay, hz))
		if b < a || b-a+2 < min || b-a > max {
			t.Errorf("%s: elapsed %d ticks outside [%d, %d]", name, b-a, min, max)
		}
	}
	check("RTP", func() uint64 { return Now(48000) }, 48000, 40*time.Millisecond)
	check("microseconds", Microseconds, 1000000, 4*time.Millisecond)
	check("jiffies", Jiffies, JiffiesPerSec, time.Second*10000000/JiffiesPerSec)
}

func TestNTP(t *testing.T) {
	now := time.Now()
	ntp := TimeToNTP(now)
	now2 := NTPToTime(ntp)
	ntp2 := TimeToNTP(now2)

	diff1 := now2.Sub(now).Abs()
	if diff1 > time.Nanosecond {
		t.Errorf("Expected %v, got %v (diff=%v)",
			now, now2, diff1)
	}

	diff2 := int64(ntp2 - ntp)
	if diff2 < 0 {
		diff2 = -diff2
	}
	if diff2 > (1 << 8) {
		t.Errorf("Expected %v, got %v (diff=%v)",
			ntp, ntp2, float64(diff2)/float64(1<<32))
	}

}
