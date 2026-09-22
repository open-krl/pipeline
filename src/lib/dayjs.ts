import dayjs from "dayjs";
import isoWeek from "dayjs/plugin/isoWeek";
import timezone from "dayjs/plugin/timezone";
import { TIMEZONE } from "../config";

dayjs.extend(isoWeek);
dayjs.extend(timezone);
dayjs.tz.setDefault(TIMEZONE);
export default dayjs;
