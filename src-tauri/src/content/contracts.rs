use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResponseContentRef {
    pub id: String,
    pub byte_length: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub charset: Option<String>,
    pub complete: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ByteRange {
    pub offset: u64,
    pub length: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContentInfo {
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_encoding: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContentWindow {
    pub offset: u64,
    pub bytes_read: u64,
    pub content: String,
    pub complete: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinePage {
    pub lines: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub complete: bool,
}

#[allow(dead_code)] // Constructed by native HTTP capture starting in Phase 6.
#[derive(Clone, Debug)]
pub struct ContentMetadata {
    pub media_type: Option<String>,
    pub charset: Option<String>,
}
