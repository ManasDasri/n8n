import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';

/**
 * The Data API rejects the whole row for a field the table does not have, so an
 * item carrying anything extra from an earlier node would never write.
 */
export function columnsPresentInTable(context: IExecuteFunctions, i: number): IDataObject {
	const item = context.getInputData()[i].json;
	const schema = context.getNodeParameter('columns.schema', i, []) as Array<{ id?: string }>;
	const known = new Set(schema.map((field) => field.id));
	if (known.size === 0) return item;

	return Object.fromEntries(Object.entries(item).filter(([column]) => known.has(column)));
}

/**
 * The mapper writes every column of the table into its value, null for the ones
 * the user left alone, so sending it unfiltered would blank real data.
 */
export function columnsTheUserSet(row: IDataObject): IDataObject {
	return Object.fromEntries(
		Object.entries(row).filter(([, value]) => value !== null && value !== undefined),
	);
}
