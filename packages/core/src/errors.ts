export class LineageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ObjectNotFoundError extends LineageError {
  constructor(public readonly hash: string) {
    super(`Object not found: ${hash}`);
  }
}

export class RefNotFoundError extends LineageError {
  constructor(public readonly ref: string) {
    super(`Ref not found: ${ref}`);
  }
}

export class RefExistsError extends LineageError {
  constructor(public readonly ref: string) {
    super(`Ref already exists: ${ref}`);
  }
}

/** Raised when a ref moved between read and write, i.e. someone else committed first. */
export class RefConflictError extends LineageError {
  constructor(
    public readonly ref: string,
    public readonly expected: string | null,
    public readonly actual: string | null,
  ) {
    super(`Ref ${ref} moved: expected ${expected ?? '(none)'}, found ${actual ?? '(none)'}`);
  }
}

export class NothingToCommitError extends LineageError {
  constructor() {
    super('Nothing to commit: tree is unchanged');
  }
}

export class UnresolvedConflictsError extends LineageError {
  constructor(public readonly unresolved: { path: string; conflictIds: string[] }[]) {
    super(
      `Unresolved conflicts in: ${unresolved
        .map((u) => (u.conflictIds.length ? `${u.path} [${u.conflictIds.join(', ')}]` : u.path))
        .join('; ')}`,
    );
  }
}

export class InvalidRefNameError extends LineageError {
  constructor(public readonly ref: string) {
    super(`Invalid ref name: ${JSON.stringify(ref)}`);
  }
}
