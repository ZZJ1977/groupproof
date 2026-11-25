"use client";

import * as React from "react";
import type { RosterStudent, TeacherClassDetail } from "@/features/teacher/api/teacher-client";

export interface TeacherWorkbenchState {
  activeCourseId?: string;
  courseDetail?: TeacherClassDetail;
  rosterStudents: RosterStudent[];
  openStudentProfile?: (student: RosterStudent) => void;
  registerCourseDetail: (courseId: string, detail?: TeacherClassDetail) => void;
  registerRoster: (
    courseId: string,
    students: RosterStudent[],
    openStudentProfile?: (student: RosterStudent) => void,
  ) => void;
  clearCourseContext: (courseId: string) => void;
}

const noop = () => {};

const defaultState: TeacherWorkbenchState = {
  activeCourseId: undefined,
  courseDetail: undefined,
  rosterStudents: [],
  openStudentProfile: undefined,
  registerCourseDetail: noop,
  registerRoster: noop,
  clearCourseContext: noop,
};

const TeacherWorkbenchContext = React.createContext<TeacherWorkbenchState>(defaultState);

export function TeacherWorkbenchProvider({ children }: { children: React.ReactNode }) {
  const [activeCourseId, setActiveCourseId] = React.useState<string | undefined>(undefined);
  const [courseDetail, setCourseDetail] = React.useState<TeacherClassDetail | undefined>(undefined);
  const [rosterStudents, setRosterStudents] = React.useState<RosterStudent[]>([]);
  const openStudentRef = React.useRef<((student: RosterStudent) => void) | undefined>(undefined);
  const [hasOpenHandler, setHasOpenHandler] = React.useState(false);

  const registerCourseDetail = React.useCallback((courseId: string, detail?: TeacherClassDetail) => {
    setActiveCourseId((prev) => (prev === courseId ? prev : courseId));
    setCourseDetail((prev) => (prev === detail ? prev : detail));
  }, []);

  const registerRoster = React.useCallback(
    (
      courseId: string,
      students: RosterStudent[],
      openHandler?: (student: RosterStudent) => void,
    ) => {
      setActiveCourseId((prev) => (prev === courseId ? prev : courseId));
      setRosterStudents((prev) => (prev === students ? prev : students));
      openStudentRef.current = openHandler;
      setHasOpenHandler(Boolean(openHandler));
    },
    [],
  );

  const clearCourseContext = React.useCallback((courseId: string) => {
    setActiveCourseId((prev) => {
      if (prev !== courseId) return prev;
      setCourseDetail(undefined);
      setRosterStudents([]);
      openStudentRef.current = undefined;
      setHasOpenHandler(false);
      return undefined;
    });
  }, []);

  const openStudentProfile = React.useMemo(
    () =>
      hasOpenHandler
        ? (student: RosterStudent) => {
            openStudentRef.current?.(student);
          }
        : undefined,
    [hasOpenHandler],
  );

  const value = React.useMemo<TeacherWorkbenchState>(
    () => ({
      activeCourseId,
      courseDetail,
      rosterStudents,
      openStudentProfile,
      registerCourseDetail,
      registerRoster,
      clearCourseContext,
    }),
    [
      activeCourseId,
      courseDetail,
      rosterStudents,
      openStudentProfile,
      registerCourseDetail,
      registerRoster,
      clearCourseContext,
    ],
  );

  return <TeacherWorkbenchContext.Provider value={value}>{children}</TeacherWorkbenchContext.Provider>;
}

export function useTeacherWorkbench(): TeacherWorkbenchState {
  return React.useContext(TeacherWorkbenchContext);
}
