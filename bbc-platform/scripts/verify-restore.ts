import { restoreBackup } from "./backup";
if (
  !process.env.RESTORE_DATABASE_URL ||
  !process.env.RESTORE_ATTACHMENT_DIR ||
  !process.argv[2]
)
  throw new Error(
    "Set RESTORE_DATABASE_URL and RESTORE_ATTACHMENT_DIR and pass a backup directory. Only an empty target is accepted.",
  );
console.log(
  await restoreBackup(
    process.env.RESTORE_DATABASE_URL,
    process.argv[2],
    process.env.RESTORE_ATTACHMENT_DIR,
  ),
);
