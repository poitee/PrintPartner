# Change one part's color

1. Open the Build's **Plan**.
2. Find the part in the table, grid, or mobile cards.
3. Select **Change color**.
4. Choose a color under **Build colors**, another available filament color, or **Custom color…**.
5. For a custom color, use the picker or enter a six-digit hex value, such as `#FF6600`.
6. Select **Save part color**.

The part keeps its role, quantity, and Checkoff progress. Other parts and the Build palette keep their colors. A changed color clears the part's previous spool assignment; select a matching spool if needed.

Build colors copy the role's current color. To replace individual choices later, change the role color or use **Reset part colors**. Both apply the role color to its parts.

STL export folders still follow color roles, such as Primary and Accent. An individual color change does not move a part into a different role folder.

If saving fails, the dialog keeps your selection. Retry **Save part color** or select **Cancel** to leave the saved color unchanged.

## Verify the behavior

From `web/`, run `npm run build`, then `npm run test:browser:part-color -w @print-partner/web`. The check starts an isolated app and tests Build colors, catalog colors, custom colors, failed-save retry, reload persistence, unchanged peers, and the mobile dialog.
