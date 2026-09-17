use rusqlite::{params, OptionalExtension, Transaction};

pub fn adopt_content(
    transaction: &Transaction<'_>,
    workspace: &str,
    execution: &str,
    content_id: &str,
    expected_length: u64,
    complete: bool,
) -> Result<(), String> {
    if !complete || content_id.is_empty() || content_id.len() > 256 {
        return Err("Invalid response content reference".into());
    }
    let expected_length =
        i64::try_from(expected_length).map_err(|_| "Invalid response content length")?;
    let existing = transaction
        .query_row(
            "SELECT workspace_id,execution_id,byte_length,state FROM response_contents WHERE id=?1",
            [content_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|_| "Cannot inspect response content")?;
    match existing {
        // Phase 2 already preserved opaque references before the native store
        // existed. Keep those records readable; only locally known content can
        // be adopted and validated against its stored metadata.
        None => Ok(()),
        Some((None, None, length, state)) if state == "ready" && length == expected_length => {
            let changed = transaction
                .execute(
                    "UPDATE response_contents
                     SET state='adopted',workspace_id=?2,execution_id=?3,expires_at=NULL
                     WHERE id=?1 AND state='ready' AND byte_length=?4",
                    params![content_id, workspace, execution, expected_length],
                )
                .map_err(|_| "Cannot adopt response content")?;
            if changed == 1 {
                Ok(())
            } else {
                Err("Response content changed while it was being adopted".into())
            }
        }
        Some((Some(owner_workspace), Some(owner_execution), length, state))
            if owner_workspace == workspace
                && owner_execution == execution
                && length == expected_length
                && state == "adopted" =>
        {
            Ok(())
        }
        _ => Err("Response content is unavailable or does not match the execution".into()),
    }
}

pub fn delete_execution_content(
    transaction: &Transaction<'_>,
    workspace: &str,
    execution: &str,
) -> Result<(), String> {
    transaction
        .execute(
            "DELETE FROM response_contents WHERE workspace_id=?1 AND execution_id=?2",
            params![workspace, execution],
        )
        .map_err(|_| "Cannot delete response content")?;
    Ok(())
}
