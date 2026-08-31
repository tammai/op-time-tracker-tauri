//! ISO 8601 duration ⇄ decimal hours.
//!
//! Port of `src/shared/utils/time.ts`. OpenProject serializes a time entry's
//! `hours` as an ISO 8601 duration (`"PT1H30M"`, `"PT45M"`, `"PT0S"`), and the
//! app works in decimal hours everywhere else. Both directions live here, in
//! one place, because a mismatch between them silently corrupts logged time.
//!
//! The frontend keeps a TypeScript copy for the calendar's own aggregation; the
//! request/response boundary uses this one.

use once_cell::sync::Lazy;
use regex::Regex;

/// The full ISO 8601 duration grammar, not just the `PT…H…M…S` subset
/// OpenProject emits — a stricter pattern would reject a valid duration from an
/// instance that spells things differently.
static DURATION_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"^(-)?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$",
    )
    .expect("duration pattern is a valid regex literal")
});

/// Parse an ISO 8601 duration into decimal hours.
///
/// `Err` for anything unparseable, including the empty `P`/`PT` form — a
/// duration with no components is not zero, it is malformed, and treating it as
/// zero would silently drop a day's logged time.
///
/// Years and months use the same nominal 365/30-day lengths the TypeScript
/// original used; OpenProject never emits either on a time entry, and a
/// calendar-accurate conversion would need an anchor date this function has no
/// business knowing.
pub fn parse_hours_to_decimal(input: &str) -> Result<f64, String> {
    let captures = DURATION_RE
        .captures(input)
        .ok_or_else(|| format!("Invalid ISO 8601 duration: \"{input}\""))?;

    let component = |index: usize| -> Option<f64> {
        captures
            .get(index)
            .map(|m| m.as_str().parse::<f64>().unwrap_or(0.0))
    };

    let (years, months, weeks, days, hours, minutes, seconds) = (
        component(2),
        component(3),
        component(4),
        component(5),
        component(6),
        component(7),
        component(8),
    );

    if years.is_none()
        && months.is_none()
        && weeks.is_none()
        && days.is_none()
        && hours.is_none()
        && minutes.is_none()
        && seconds.is_none()
    {
        return Err(format!(
            "Invalid ISO 8601 duration: \"{input}\" has no components"
        ));
    }

    let total = years.unwrap_or(0.0) * 365.0 * 24.0
        + months.unwrap_or(0.0) * 30.0 * 24.0
        + weeks.unwrap_or(0.0) * 7.0 * 24.0
        + days.unwrap_or(0.0) * 24.0
        + hours.unwrap_or(0.0)
        + minutes.unwrap_or(0.0) / 60.0
        + seconds.unwrap_or(0.0) / 3600.0;

    let signed = if captures.get(1).is_some() {
        -total
    } else {
        total
    };
    // Six decimal places: enough that a minute round-trips exactly, few enough
    // that binary-float noise never reaches the UI.
    Ok((signed * 1_000_000.0).round() / 1_000_000.0)
}

/// Format decimal hours as the ISO 8601 duration OpenProject accepts.
///
/// Rejects a negative or non-finite input rather than clamping: both mean the
/// caller computed something wrong, and a request built from it would write
/// nonsense to the server.
pub fn format_decimal_hours_to_iso(hours: f64) -> Result<String, String> {
    if !hours.is_finite() {
        return Err(format!(
            "Invalid decimal hours: expected a finite number, got {hours}"
        ));
    }
    if hours < 0.0 {
        return Err(format!(
            "Invalid decimal hours: must not be negative, got {hours}"
        ));
    }

    let total_seconds = (hours * 3600.0).round() as i64;
    if total_seconds == 0 {
        return Ok("PT0S".to_string());
    }

    let h = total_seconds / 3600;
    let m = (total_seconds % 3600) / 60;
    let s = total_seconds % 60;

    let mut out = String::from("PT");
    if h > 0 {
        out.push_str(&format!("{h}H"));
    }
    if m > 0 {
        out.push_str(&format!("{m}M"));
    }
    if s > 0 {
        out.push_str(&format!("{s}S"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hours(input: &str) -> f64 {
        parse_hours_to_decimal(input).expect("valid duration")
    }

    #[test]
    fn parses_the_durations_openproject_emits() {
        assert_eq!(hours("PT1H30M"), 1.5);
        assert_eq!(hours("PT45M"), 0.75);
        assert_eq!(hours("PT2H"), 2.0);
        assert_eq!(hours("PT0S"), 0.0);
        assert_eq!(hours("PT8H"), 8.0);
        assert_eq!(hours("PT1H30M30S"), 1.508333);
    }

    #[test]
    fn parses_the_wider_grammar_and_signs() {
        assert_eq!(hours("P1D"), 24.0);
        assert_eq!(hours("P1W"), 168.0);
        assert_eq!(hours("-PT30M"), -0.5);
    }

    #[test]
    fn rejects_malformed_and_componentless_durations() {
        assert!(parse_hours_to_decimal("").is_err());
        assert!(parse_hours_to_decimal("1h30m").is_err());
        assert!(parse_hours_to_decimal("P").is_err());
        assert!(parse_hours_to_decimal("PT").is_err());
    }

    #[test]
    fn formats_decimal_hours_back() {
        assert_eq!(format_decimal_hours_to_iso(1.5).unwrap(), "PT1H30M");
        assert_eq!(format_decimal_hours_to_iso(0.75).unwrap(), "PT45M");
        assert_eq!(format_decimal_hours_to_iso(2.0).unwrap(), "PT2H");
        assert_eq!(format_decimal_hours_to_iso(0.0).unwrap(), "PT0S");
        assert_eq!(format_decimal_hours_to_iso(8.25).unwrap(), "PT8H15M");
    }

    #[test]
    fn rejects_negative_and_non_finite_hours() {
        assert!(format_decimal_hours_to_iso(-1.0).is_err());
        assert!(format_decimal_hours_to_iso(f64::NAN).is_err());
        assert!(format_decimal_hours_to_iso(f64::INFINITY).is_err());
    }

    #[test]
    fn round_trips_every_quarter_hour() {
        for step in 0..=96 {
            let decimal = f64::from(step) * 0.25;
            let iso = format_decimal_hours_to_iso(decimal).unwrap();
            assert_eq!(parse_hours_to_decimal(&iso).unwrap(), decimal, "{iso}");
        }
    }
}
