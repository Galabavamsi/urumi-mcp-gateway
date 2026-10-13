/**
 * A problem with what the caller asked for (bad date, unparsable price...). Tools turn it into an
 * `isError` result with this message, so the model can fix its arguments and try again.
 */
export class UserInputError extends Error {
  override name = 'UserInputError';
}
