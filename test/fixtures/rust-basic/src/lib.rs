/// Adds two numbers, saturating at `u32::MAX`.
pub fn add(a: u32, b: u32) -> u32 {
    a.saturating_add(b)
}

#[cfg(test)]
mod tests {
    use super::add;

    #[test]
    fn adds() {
        assert_eq!(add(2, 3), 5);
    }

    #[test]
    fn saturates() {
        assert_eq!(add(u32::MAX, 1), u32::MAX);
    }
}
