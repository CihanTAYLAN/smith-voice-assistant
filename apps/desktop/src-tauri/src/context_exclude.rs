#[derive(Debug, Default)]
pub(crate) struct ContextExclude {
    source_globs: Vec<String>,
    keywords: Vec<String>,
}

impl ContextExclude {
    pub(crate) fn from_env() -> Self {
        Self::parse(&std::env::var("SMITH_CONTEXT_EXCLUDE").unwrap_or_default())
    }

    pub(crate) fn parse(raw: &str) -> Self {
        let mut rules = Self::default();
        for item in raw.split(',') {
            let normalized = case_fold(item.trim());
            if normalized.is_empty() {
                continue;
            }
            if let Some(keyword) = normalized.strip_prefix("kw:") {
                let keyword = keyword.trim();
                if !keyword.is_empty() {
                    rules.keywords.push(keyword.to_string());
                }
            } else {
                rules.source_globs.push(normalized);
            }
        }
        rules
    }

    pub(crate) fn matches(&self, source_id: &str, content: &str) -> bool {
        let source_id = case_fold(source_id);
        if self
            .source_globs
            .iter()
            .any(|glob| glob_matches(&source_id, glob))
        {
            return true;
        }
        let content = case_fold(content);
        self.keywords
            .iter()
            .any(|keyword| content.contains(keyword))
    }
}

fn case_fold(value: &str) -> String {
    value
        .chars()
        .filter(|char| *char != '\u{0307}')
        .flat_map(|char| match char {
            'I' | '\u{0130}' | '\u{0131}' | 'i' => 'i'.to_lowercase(),
            _ => char.to_lowercase(),
        })
        .collect()
}

fn glob_matches(value: &str, pattern: &str) -> bool {
    let value: Vec<char> = value.chars().collect();
    let mut previous = vec![false; value.len() + 1];
    previous[0] = true;
    for token in pattern.chars() {
        let mut current = vec![false; value.len() + 1];
        if token == '*' {
            current[0] = previous[0];
        }
        for index in 1..=value.len() {
            current[index] = if token == '*' {
                previous[index] || current[index - 1]
            } else {
                previous[index - 1] && (token == '?' || token == value[index - 1])
            };
        }
        previous = current;
    }
    previous[value.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_glob_keyword_ve_turkce_i_eslesir() {
        let rules =
            ContextExclude::parse(" obsidian:acme/*, code:_workshop-smoke/??, kw:ISTANBUL, kw: ");
        assert!(rules.matches("obsidian:ACME/a.md", "temiz"));
        assert!(rules.matches("code:_workshop-smoke/ab", "temiz"));
        assert!(!rules.matches("code:_workshop-smoke/abc", "temiz"));
        assert!(rules.matches("note:1", "istanbul bilgisi"));
        assert!(rules.matches("note:2", "ISTANBUL bilgisi"));
        assert!(!rules.matches("note:3", "ankara bilgisi"));
    }

    #[test]
    fn bos_kural_no_op() {
        assert!(!ContextExclude::parse(" , , ").matches("obsidian:acme/a.md", "Acme"));
    }
}
